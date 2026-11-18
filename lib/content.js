/**
 * Content search: text files and DSH session messages in SQLite FTS5.
 *
 * File names stay in the Go engine. This store is built from the engine's
 * `dump` RPC plus the session logs: Node reads text bodies, decompresses
 * `session.v4.jsonl.zstd`, and SQLite's trigram tokenizer gives substring and
 * CJK search. A meta table stores each source's mtime so refresh() only
 * re-reads what changed; rebuild() drops and rebuilds everything.
 *
 * Everything here runs inside the DSH host process, so the build must never
 * monopolise its event loop: file reads and zstd decoding are asynchronous and
 * the loops yield to the scheduler every ~8 ms of work. Session logs are read
 * only once they have settled (an actively written session is skipped until it
 * has been quiet for `activeSessionDelayMs`), and archived sessions are left
 * alone unless `includeArchived` is set.
 * @module dsh-locator/content
 */
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { zstdDecompress } from 'node:zlib';
import { scheduler } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { escapeLike, searchContent } from "./content-search.js";
import { attachmentRef, normalizeUrl, sessionEventRef, spillRef, urlRef } from "./refs.js";
import { documentFormat, extractDocument } from "./extract.js";
import { estimateSymbolTokens, extractSymbols, languageForPath } from "./symbols.js";
const SCHEMA_VERSION = 3;
/** Work budget between two event-loop yields; keeps host latency low. */
const SLICE_MS = 8;
/** Wall-clock start of this process; distinguishes a reused pid from a live sibling. */
const PROCESS_START = Math.round(Date.now() - process.uptime() * 1000);
/** Session bodies are short: a message, not a whole file. */
const SESSION_BODY_BYTES = 8_000;
const zstdDecompressAsync = promisify(zstdDecompress);
// `scheduler.yield` is newer than the oldest supported Node line; fall back to
// setImmediate so a build on Node 22 still yields instead of throwing.
const yieldToLoop = typeof scheduler.yield === 'function'
    ? () => scheduler.yield()
    : () => new Promise(resolve => { setImmediate(resolve); });
const TEXT_EXTENSIONS = new Set([
    '.txt', '.md', '.markdown', '.rst', '.log', '.csv', '.tsv', '.json', '.jsonl',
    '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.xml', '.html', '.htm',
    '.css', '.scss', '.less', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
    '.go', '.rs', '.py', '.rb', '.php', '.java', '.kt', '.swift', '.c', '.h',
    '.cc', '.cpp', '.hpp', '.cs', '.sh', '.bash', '.zsh', '.fish', '.ps1',
    '.sql', '.graphql', '.proto', '.tex', '.org', '.adoc',
]);
/** Default cap on one document handed to the extractor (20 MiB). */
const DOCUMENT_EXTRACT_MAX_BYTES = 20 * 1024 * 1024;
/** Default cap on one code file that contributes symbols to the repo map. */
const SYMBOL_MAX_FILE_BYTES = 512 * 1024;
/** Symbols stored per file; a generated file must not flood the symbol table. */
const MAX_SYMBOLS_PER_FILE = 2_000;
export class ContentIndex {
    rt;
    options;
    db = null;
    state = { building: false, files: 0, sessions: 0, messages: 0, truncated: false, error: '', warnings: [], updatedAt: 0 };
    generation = 0;
    totalBytes = 0;
    sliceDeadline = 0;
    worker = null;
    lockHeld = false;
    lockToken = randomUUID();
    workerSeq = 0;
    pendingStart = false;
    progress = null;
    dbIdentity = null;
    /** Session id → indexed session log path, for session-scoped content search. */
    sessionPaths = new Map();
    /** Archived session ids, excluded from queries unless asked for. */
    archivedSessions = new Set();
    /** Session id → the session header's cwd, for caller/workspace authorization. */
    sessionCwds = new Map();
    /** A legacy database gained `sources.cwd`; rebuild session docs to fill it. */
    needsSessionBackfill = false;
    /** A database predating the additive `symbols` table needs a one-time fill. */
    needsSymbolBackfill = false;
    pending = new Map();
    constructor(rt, options) {
        this.rt = rt;
        this.options = options;
    }
    status() {
        if (this.db !== null && !this.state.building && !this.databaseIsCurrent())
            this.recoverExternal();
        const progress = this.progress;
        return {
            ...this.state,
            warnings: [...this.state.warnings],
            building: this.state.building || this.pendingStart,
            ...(progress === null ? {} : { progress: { ...progress } }),
            fullIndex: this.options.maxTotalBytes === 0 && this.options.maxFiles === 0,
            reasoningIndex: this.options.includeReasoning === true,
            toolResultsIndex: this.options.includeToolResults === true,
            ...(this.db === null ? {} : { refs: this.refsByKind() }),
        };
    }
    /**
     * Report a lazy build as in progress before the asynchronous start reaches
     * `boot()`, so the panel/agent sees "building" on the very first query
     * instead of an empty result with no hint.
     */
    markPending() {
        if (this.state.building)
            return;
        this.state.error = '';
        this.pendingStart = true;
    }
    /** Drop the pending flag when the lazy start failed before it began. */
    clearPending() {
        this.pendingStart = false;
    }
    /** Queue a full rebuild; false when one is already running. */
    rebuild() {
        if (this.state.building)
            return false;
        this.start();
        return true;
    }
    /** Queue an incremental refresh; false when one is already running. */
    refreshNow() {
        if (this.state.building)
            return false;
        this.refresh();
        return true;
    }
    close() {
        this.generation++;
        this.db?.close();
        this.db = null;
        this.state.building = false;
        this.stopWorker();
        this.releaseLock();
        this.pendingStart = false;
        this.progress = null;
        this.dbIdentity = null;
        this.sessionPaths.clear();
        this.sessionCwds.clear();
    }
    /** Build everything from scratch. */
    start() { this.begin('full'); }
    /**
     * Start at plugin boot: reuse an existing database and refresh it
     * incrementally, so a restart does not re-read and re-index gigabytes of
     * text. A missing or incompatible database falls back to a full build.
     */
    boot() {
        // A content operation that ran before the deferred boot may have built the
        // database already; do not start a second pass behind it.
        if (this.state.updatedAt > 0)
            return;
        this.begin(existsSync(join(this.options.stateDir, 'content.db')) ? 'incremental' : 'full');
    }
    /** Re-read changed files/sessions; open the DB when this is the first run. */
    refresh() { this.begin(this.db === null ? 'full' : 'incremental'); }
    /**
     * Serialize content builds across plugin instances and DSH processes that
     * share a state directory: a stale lock (dead pid or older than 30 minutes)
     * is taken over, a live one keeps this instance from writing concurrently.
     * @returns whether this instance owns the build lock.
     */
    acquireLock() {
        if (this.lockHeld)
            return true;
        mkdirSync(this.options.stateDir, { recursive: true, mode: 0o700 });
        const path = join(this.options.stateDir, 'content.lock');
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const fd = openSync(path, 'wx', 0o600);
                writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now(), token: this.lockToken, procStart: PROCESS_START }));
                closeSync(fd);
                this.lockHeld = true;
                return true;
            }
            catch {
                let holder = {};
                try {
                    holder = JSON.parse(readFileSync(path, 'utf8'));
                }
                catch { /* unreadable: treat as stale */ }
                const age = Date.now() - Number(holder.startedAt ?? 0);
                let alive = false;
                if (typeof holder.pid === 'number' && age < 30 * 60_000) {
                    try {
                        process.kill(holder.pid, 0);
                        alive = true;
                    }
                    catch (error) {
                        alive = error.code === 'EPERM';
                    }
                }
                // A live sibling instance (for example during profile HMR) blocks even
                // when it shares our pid; the per-instance token tells them apart. A
                // reused pid from an earlier process incarnation is stale, not live.
                const sameProcess = holder.procStart === undefined || Math.abs(Number(holder.procStart) - PROCESS_START) < 5_000;
                if (alive && sameProcess && holder.token !== this.lockToken)
                    return false;
                try {
                    rmSync(path, { force: true });
                }
                catch {
                    return false;
                }
            }
        }
        return false;
    }
    releaseLock() {
        if (!this.lockHeld)
            return;
        this.lockHeld = false;
        try {
            rmSync(join(this.options.stateDir, 'content.lock'), { force: true });
        }
        catch { /* ignore */ }
    }
    begin(mode) {
        if (this.state.building)
            return;
        this.pendingStart = false;
        if (!this.acquireLock()) {
            this.state.error = 'another dsh-locator content build is running';
            return;
        }
        const generation = ++this.generation;
        this.state.building = true;
        this.state.error = '';
        this.state.truncated = false;
        this.state.warnings = [];
        this.progress = null;
        const run = mode === 'full' ? this.full(generation) : this.incremental(generation);
        void run.catch(error => {
            if (generation !== this.generation)
                return;
            this.state.error = messageOf(error);
            this.state.building = false;
            this.progress = null;
        }).finally(() => {
            this.releaseLock();
        });
    }
    async full(generation) {
        this.open(true);
        this.totalBytes = 0;
        await this.indexSessions(generation);
        this.needsSessionBackfill = false;
        if (generation !== this.generation)
            return;
        await this.indexFiles(generation);
        if (generation !== this.generation)
            return;
        // A full build indexed symbols for every file; no backfill is pending.
        this.needsSymbolBackfill = false;
        this.finish();
    }
    async incremental(generation) {
        try {
            this.open(false);
            const stored = this.db.prepare('PRAGMA user_version').get()?.user_version ?? 0;
            if (Number(stored) !== SCHEMA_VERSION)
                return await this.full(generation);
            if (this.needsSessionBackfill) {
                // Upgrading an existing database added `sources.cwd`; session docs must
                // be re-read once so the authorization rule has a cwd for every log.
                this.needsSessionBackfill = false;
                this.clearSessions();
                await this.indexSessions(generation);
                if (generation !== this.generation)
                    return;
                await this.syncSymbols(generation);
                if (generation !== this.generation)
                    return;
                this.finish();
                return;
            }
            // A database whose last build never finished (crash, update, forced
            // reload) has a stale byte counter; rebuild instead of trusting it.
            if (this.readFlag('complete') !== 1)
                return await this.full(generation);
            // The reasoning flag is absent in databases built before 0.11.2; default
            // to "not indexed" without forcing a rebuild. Turning reasoning on (or
            // later off) rebuilds sessions so old rows cannot keep stale thinking.
            const storedReasoning = this.readFlag('reasoning');
            const wantReasoning = this.options.includeReasoning === true ? 1 : 0;
            const storedToolResults = this.readFlag('toolResults') ?? 0;
            const wantToolResults = this.options.includeToolResults === true ? 1 : 0;
            // Changing reasoning/tool-result participation only invalidates session
            // rows. Keep the file index instead of dropping/rebuilding 185k files.
            this.totalBytes = this.readTotalBytes();
            if ((storedReasoning ?? 0) !== wantReasoning || storedToolResults !== wantToolResults) {
                this.clearSessions();
                await this.indexSessions(generation);
                if (generation !== this.generation)
                    return;
                await this.syncSymbols(generation);
                if (generation !== this.generation)
                    return;
                this.finish();
                return;
            }
            // Symbols are additive and can be toggled without dropping file bodies;
            // a database built before the table existed needs a one-time fill.
            await this.syncSymbols(generation);
            if (generation !== this.generation)
                return;
            // A smaller cap must be enforced against rows written under the previous
            // larger budget; incremental refresh only adds, it never trims.
            if (!this.capsSatisfied())
                return await this.full(generation);
            await this.refreshFiles(generation);
            if (generation !== this.generation)
                return;
            await this.refreshSessions(generation);
            if (generation !== this.generation)
                return;
            this.finish();
        }
        catch (error) {
            if (generation !== this.generation)
                return;
            // A background engine re-scan (periodic fallback rebuild or
            // locator_rebuild) swaps the index and moves the dump cursor under us.
            // That is transient: keep the database and let the next refresh retry
            // instead of dropping it and re-reading every indexed file.
            if (isEngineRescanError(error)) {
                this.state.building = false;
                this.progress = null;
                this.addWarning('content-refresh-deferred');
                return;
            }
            // A corrupt or outdated database must not disable content search for the
            // rest of the session: rebuild it from scratch instead.
            this.db?.close();
            this.db = null;
            await this.full(generation);
        }
    }
    open(fresh) {
        const existedDir = existsSync(this.options.stateDir);
        mkdirSync(this.options.stateDir, { recursive: true, mode: 0o700 });
        if (!existedDir) {
            try {
                chmodSync(this.options.stateDir, 0o700);
            }
            catch { /* Windows or a read-only profile */ }
        }
        const dbPath = join(this.options.stateDir, 'content.db');
        const existed = existsSync(dbPath);
        if (existed) {
            const verdict = this.classifyDatabase(dbPath);
            if (verdict === 'foreign') {
                throw new Error(`content.db is not a dsh-locator database, refusing to touch it: ${dbPath}`);
            }
            if (verdict !== 'ok') {
                // A corrupt, empty or older-schema database must not disable content
                // search for the rest of the session. Keep the bad file for diagnosis
                // (rename, never delete bytes we did not create) and rebuild fresh.
                // During an incremental open this throws so the caller falls back to a
                // full rebuild; a full open simply continues with a clean file.
                this.quarantineDatabase(dbPath, verdict);
                if (!fresh)
                    throw new Error('content database is incompatible; rebuilding');
            }
        }
        let oldFileRemained = false;
        if (fresh) {
            // A full rebuild throws every row away. Dropping the FTS tables in place
            // on a multi-GB database blocks the host for about a second, so recreate
            // the file instead: the worker is stopped and the sidecars go with it.
            this.stopWorker();
            try {
                this.db?.close();
            }
            catch { /* ignore */ }
            this.db = null;
            for (const suffix of ['', '-wal', '-shm']) {
                try {
                    rmSync(dbPath + suffix, { force: true });
                }
                catch { /* Windows keeps a busy file; DROP below still works */ }
            }
            oldFileRemained = existsSync(dbPath);
        }
        this.db?.close();
        this.db = new DatabaseSync(dbPath);
        this.dbIdentity = this.identityOf(dbPath);
        try {
            chmodSync(dbPath, 0o600);
        }
        catch { /* Windows or a read-only profile */ }
        this.db.exec('PRAGMA journal_mode = WAL');
        this.db.exec('PRAGMA synchronous = OFF');
        if (fresh && oldFileRemained) {
            // Fallback for the rare recreate failure above: still start from empty.
            this.db.exec('DROP TABLE IF EXISTS docs');
            this.db.exec('DROP TABLE IF EXISTS docs_meta');
            this.db.exec('DROP TABLE IF EXISTS sources');
            this.db.exec('DROP TABLE IF EXISTS symbols');
        }
        this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(
      body, kind UNINDEXED, path UNINDEXED, title UNINDEXED,
      session_id UNINDEXED, message_id UNINDEXED, tokenize = 'trigram'
    )`);
        this.db.exec('CREATE TABLE IF NOT EXISTS docs_meta (rowid INTEGER PRIMARY KEY, doc_key TEXT UNIQUE, path TEXT, mtime INTEGER, kind TEXT, node_key TEXT)');
        this.ensureDocsMetaFormatColumn();
        this.db.exec('CREATE TABLE IF NOT EXISTS sources (path TEXT PRIMARY KEY, mtime INTEGER)');
        if (this.ensureSourcesCwdColumn())
            this.needsSessionBackfill = true;
        if (this.ensureRefsTables())
            this.needsSessionBackfill = true;
        if (this.ensureSymbolsTables())
            this.needsSymbolBackfill = true;
        this.db.exec('CREATE INDEX IF NOT EXISTS docs_meta_path ON docs_meta(path)');
        if (fresh) {
            this.db.exec('DROP TABLE IF EXISTS content_meta');
        }
        this.db.exec('CREATE TABLE IF NOT EXISTS content_meta (key TEXT PRIMARY KEY, value INTEGER)');
        if (fresh) {
            this.db.exec("INSERT OR REPLACE INTO content_meta (key, value) VALUES ('total_bytes', 0)");
            this.db.exec("INSERT OR REPLACE INTO content_meta (key, value) VALUES ('complete', 0)");
        }
        if (fresh)
            this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
        this.refreshSessionPaths();
        this.reopenWorker();
    }
    /**
     * Decide what an existing `content.db` is before touching it:
     * - `foreign`: no dsh-locator table at all — refuse to modify it.
     * - `corrupt`: zero bytes, unreadable, or not a SQLite database.
     * - `incompatible`: has our tables but a different schema version/shape.
     * - `ok`: safe to reuse.
     */
    classifyDatabase(path) {
        let size = 0;
        try {
            size = statSync(path).size;
        }
        catch {
            return 'corrupt';
        }
        if (size === 0)
            return 'corrupt';
        let probe;
        try {
            probe = new DatabaseSync(path, { readOnly: true });
            const names = new Set(probe.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
                .map(row => row.name)
                .filter((name) => typeof name === 'string'));
            const owned = ['docs', 'docs_meta', 'sources', 'content_meta'];
            if (!owned.some(name => names.has(name)))
                return 'foreign';
            if (!names.has('docs') || !names.has('docs_meta') || !names.has('sources') || !names.has('content_meta'))
                return 'incompatible';
            const version = probe.prepare('PRAGMA user_version').get()?.user_version ?? 0;
            if (Number(version) !== SCHEMA_VERSION)
                return 'incompatible';
            return 'ok';
        }
        catch {
            return 'corrupt';
        }
        finally {
            try {
                probe?.close();
            }
            catch { /* ignore */ }
        }
    }
    /**
     * Move a broken/outdated database aside instead of destroying it. The
     * timestamped name keeps the bytes around for inspection; if the rename
     * fails (another process still holds it on Windows) a fresh file is still
     * created so content search recovers.
     */
    quarantineDatabase(dbPath, verdict) {
        this.stopWorker();
        try {
            this.db?.close();
        }
        catch { /* ignore */ }
        this.db = null;
        const target = `${dbPath}.corrupt-${Date.now()}`;
        try {
            renameSync(dbPath, target);
            this.addWarning(verdict === 'corrupt' ? 'content-db-corrupt' : 'content-db-incompatible');
        }
        catch {
            try {
                rmSync(dbPath, { force: true });
            }
            catch { /* ignore */ }
            this.addWarning(verdict === 'corrupt' ? 'content-db-corrupt' : 'content-db-incompatible');
        }
        for (const suffix of ['-wal', '-shm']) {
            try {
                rmSync(dbPath + suffix, { force: true });
            }
            catch { /* ignore */ }
        }
    }
    /** Record one non-fatal build warning (deduplicated, bounded). */
    addWarning(warning) {
        if (this.state.warnings.includes(warning))
            return;
        if (this.state.warnings.length >= 20)
            return;
        this.state.warnings.push(warning);
    }
    reopenWorker() {
        if (this.worker === null)
            return;
        try {
            this.worker.postMessage({ id: ++this.workerSeq, open: join(this.options.stateDir, 'content.db') });
        }
        catch { /* a dying worker is replaced on the next query */ }
    }
    stopWorker() {
        const worker = this.worker;
        this.worker = null;
        for (const resolve of this.pending.values())
            resolve(workerFailureResult('content-search-worker-failed'));
        this.pending.clear();
        if (worker !== null)
            void worker.terminate();
    }
    /**
     * Whether a usable search worker exists, creating one when needed.
     * @returns false when the worker cannot be created at all; that is the only
     *          case in which an in-process (sync) query is allowed.
     */
    ensureWorker() {
        if (this.options.searchWorker !== true)
            return false;
        if (this.worker !== null)
            return true;
        // In a TypeScript test run the compiled worker does not exist next to the
        // source; answer queries in-process instead (budgeted, see searchSync).
        const workerPath = fileURLToPath(new URL('./content-search-worker.js', import.meta.url));
        const factory = this.options.searchWorkerFactory;
        if (factory === undefined && !existsSync(workerPath))
            return false;
        try {
            const worker = factory !== undefined
                ? factory(workerPath)
                : new Worker(workerPath, { workerData: { dbPath: join(this.options.stateDir, 'content.db') } });
            worker.on('message', (message) => { this.onWorkerMessage(message); });
            const fail = () => {
                if (this.worker !== worker)
                    return;
                this.worker = null;
                for (const resolve of this.pending.values())
                    resolve(workerFailureResult('content-search-worker-failed'));
                this.pending.clear();
            };
            worker.on('error', fail);
            worker.on('exit', fail);
            this.worker = worker;
            return true;
        }
        catch {
            this.worker = null;
            return false;
        }
    }
    /**
     * Resolve one worker reply. A malformed reply is reported as a protocol
     * error; the query is never retried on the host thread.
     */
    onWorkerMessage(message) {
        if (typeof message !== 'object' || message === null)
            return;
        const record = message;
        if (typeof record.id !== 'number')
            return;
        const resolve = this.pending.get(record.id);
        if (resolve === undefined)
            return;
        this.pending.delete(record.id);
        resolve(isContentSearchResult(record.result) ? record.result : workerFailureResult('content-search-worker-protocol-error'));
    }
    identityOf(path) {
        try {
            const info = statSync(path);
            return { dev: Number(info.dev), ino: Number(info.ino) };
        }
        catch {
            return null;
        }
    }
    /**
     * Whether the open handle still points at the file on disk. Another DSH
     * process that shares this `stateDir` can recreate `content.db` during its
     * full rebuild; our handle would then keep reading the unlinked inode until
     * the process exits. Windows reports ino 0 for some filesystems, in which
     * case the check is skipped rather than producing false positives.
     */
    databaseIsCurrent() {
        if (this.dbIdentity === null || this.dbIdentity.ino === 0)
            return true;
        const current = this.identityOf(join(this.options.stateDir, 'content.db'));
        return current !== null && current.dev === this.dbIdentity.dev && current.ino === this.dbIdentity.ino;
    }
    /** Close the stale handle and reopen/rebuild from the file now on disk. */
    recoverExternal() {
        if (this.state.building)
            return;
        this.generation++;
        try {
            this.db?.close();
        }
        catch { /* ignore */ }
        this.db = null;
        this.dbIdentity = null;
        this.stopWorker();
        this.totalBytes = 0;
        this.sessionPaths.clear();
        this.sessionCwds.clear();
        this.state.updatedAt = 0;
        this.state.error = '';
        this.state.truncated = false;
        this.state.files = 0;
        this.state.sessions = 0;
        this.state.messages = 0;
        this.progress = null;
        this.boot();
    }
    /** Whether the engine is re-scanning, which can move its dump cursor. */
    engineRescanning() {
        const scanning = this.rt.status?.scanning;
        return scanning !== undefined && scanning !== null;
    }
    /** Remove all session documents, keeping file documents and their bytes. */
    clearSessions() {
        const row = this.db.prepare(`SELECT COALESCE(SUM(length(d.body)), 0) AS n
      FROM docs_meta m LEFT JOIN docs d ON d.rowid = m.rowid WHERE m.kind = 'session'`).get();
        this.db.exec("DELETE FROM docs WHERE rowid IN (SELECT rowid FROM docs_meta WHERE kind = 'session')");
        this.db.exec("DELETE FROM docs_meta WHERE kind = 'session'");
        this.db.exec('DELETE FROM sources');
        this.db.exec('DELETE FROM refs');
        this.db.exec('DELETE FROM refs_meta');
        this.totalBytes = Math.max(0, this.totalBytes - Number(row?.n ?? 0));
    }
    /** Whether the stored rows already respect the configured file/body caps. */
    capsSatisfied() {
        const maxTotal = this.options.maxTotalBytes ?? 0;
        if (maxTotal > 0 && this.totalBytes > maxTotal)
            return false;
        if (this.options.maxFiles > 0) {
            const count = this.db.prepare("SELECT COUNT(*) AS n FROM docs_meta WHERE kind = 'file'").get();
            if (Number(count?.n ?? 0) > this.options.maxFiles)
                return false;
        }
        if (this.options.maxFileBytes > 0) {
            const oversized = this.db.prepare('SELECT 1 AS n FROM docs WHERE kind = ? AND length(body) > ? LIMIT 1').get('file', this.options.maxFileBytes);
            if (oversized !== undefined)
                return false;
        }
        return true;
    }
    readFlag(key) {
        const row = this.db.prepare('SELECT value FROM content_meta WHERE key = ?').get(key);
        return row?.value === undefined ? undefined : Number(row.value);
    }
    writeFlag(key, value) {
        this.db.prepare('INSERT OR REPLACE INTO content_meta (key, value) VALUES (?, ?)').run(key, value);
    }
    /**
     * Body bytes already stored. Reading a persisted counter avoids a full scan
     * of every FTS body (measured ~0.6 s for 1 GB) at the start of each refresh.
     * A database written before the counter existed falls back to one scan.
     */
    readTotalBytes() {
        const row = this.db.prepare("SELECT value FROM content_meta WHERE key = 'total_bytes'").get();
        if (row?.value !== undefined)
            return Number(row.value);
        const scanned = Number(this.db.prepare('SELECT COALESCE(SUM(length(body)), 0) AS n FROM docs').get().n);
        this.db.prepare("INSERT OR REPLACE INTO content_meta (key, value) VALUES ('total_bytes', ?)").run(scanned);
        return scanned;
    }
    writeTotalBytes() {
        this.db.prepare("INSERT OR REPLACE INTO content_meta (key, value) VALUES ('total_bytes', ?)").run(Math.max(0, Math.round(this.totalBytes)));
    }
    /** Yield to the host event loop once the current ~8 ms work slice is spent. */
    async breathe() {
        const now = performance.now();
        if (now < this.sliceDeadline)
            return;
        this.sliceDeadline = now + SLICE_MS;
        await yieldToLoop();
    }
    /** True when a session log has been quiet long enough to be read safely. */
    settled(mtime) {
        const delay = this.options.activeSessionDelayMs ?? 0;
        return delay <= 0 || Date.now() - mtime >= delay;
    }
    /** Start one build phase; `total` becomes the progress denominator when known. */
    beginPhase(phase, total) {
        this.progress = { phase, scanned: 0, indexed: 0, startedAt: Date.now(), ...(total === undefined ? {} : { total }) };
    }
    /** Forget live progress once a build finishes, fails or is abandoned. */
    clearProgress() {
        this.progress = null;
    }
    /** Count one examined entry and keep its path for the "current item" hint. */
    scanEntry(path) {
        const progress = this.progress;
        if (progress === null)
            return;
        progress.scanned++;
        progress.path = path;
    }
    /** Count one entry that produced a stored row. */
    countIndexed(amount = 1) {
        if (this.progress !== null)
            this.progress.indexed += amount;
    }
    /** Total engine entries, used as the files-phase progress denominator. */
    async engineEntries() {
        const cached = this.rt.status?.engine?.entries;
        if (typeof cached === 'number' && cached > 0)
            return cached;
        const engineStatus = this.rt.engineStatus;
        if (typeof engineStatus !== 'function')
            return undefined;
        try {
            const status = await engineStatus.call(this.rt);
            const entries = status?.entries;
            return typeof entries === 'number' && entries > 0 ? entries : undefined;
        }
        catch {
            return undefined;
        }
    }
    finish() {
        this.clearProgress();
        const counts = this.db.prepare("SELECT kind, COUNT(*) AS n FROM docs_meta GROUP BY kind").all();
        this.state.files = Number(counts.find(row => row.kind === 'file')?.n ?? 0);
        this.state.messages = Number(counts.find(row => row.kind === 'session')?.n ?? 0);
        this.state.sessions = Number(this.db.prepare('SELECT COUNT(*) AS n FROM sources').get().n);
        this.state.building = false;
        this.state.updatedAt = Date.now();
        this.writeTotalBytes();
        this.writeFlag('complete', 1);
        this.writeFlag('reasoning', this.options.includeReasoning === true ? 1 : 0);
        this.writeFlag('toolResults', this.options.includeToolResults === true ? 1 : 0);
        this.writeFlag('symbols', this.indexSymbolsEnabled() ? 1 : 0);
        this.refreshSessionPaths();
        this.reopenWorker();
    }
    /**
     * Rebuild the session id → session log path map from the persisted sources.
     * Runs after `open()` and after every build/refresh, so session-scoped
     * searches work against an existing database before the first refresh ends.
     */
    refreshSessionPaths() {
        this.sessionPaths.clear();
        if (this.db === null)
            return;
        try {
            const rows = this.db.prepare('SELECT path, cwd FROM sources').all();
            for (const row of rows) {
                const path = row.path;
                if (typeof path !== 'string' || path === '')
                    continue;
                const sessionId = basename(dirname(path));
                if (sessionId !== '')
                    this.sessionPaths.set(sessionId, path);
                if (sessionId !== '' && typeof row.cwd === 'string' && row.cwd !== '')
                    this.sessionCwds.set(sessionId, row.cwd);
            }
        }
        catch {
            // A database from an older schema cannot answer session-scoped queries
            // until its next rebuild; leave the map empty instead of failing boot.
        }
    }
    addDoc(row) {
        const cap = this.options.maxTotalBytes ?? 0;
        // Replacing an existing document frees its old body first: an unchanged
        // file rewritten at refresh time must not be rejected because its stale
        // copy still occupies the budget.
        const previous = this.storedBytes(row.key);
        if (cap > 0 && this.totalBytes - previous + row.body.length > cap) {
            this.state.truncated = true;
            return false;
        }
        this.deleteDoc(row.key);
        const meta = this.db.prepare('INSERT INTO docs_meta (doc_key, path, mtime, kind, node_key, format) VALUES (?, ?, ?, ?, ?, ?)').run(row.key, row.path, row.mtime, row.kind, row.nodeKey, row.format ?? null);
        const rowid = meta.lastInsertRowid;
        this.db.prepare('INSERT INTO docs (rowid, body, kind, path, title, session_id, message_id) VALUES (?, ?, ?, ?, ?, ?, ?)').run(rowid, row.body, row.kind, row.path, row.title, row.sessionId, row.messageId);
        this.totalBytes += row.body.length;
        // Symbols follow the body: a file rejected by the body budget stays out of
        // the outline too, so every repo-map entry is also a searchable document.
        if (row.symbols !== undefined)
            this.writeSymbols(row.path, row.symbols);
        return true;
    }
    /** Body bytes stored for one document key (0 when it is not indexed). */
    storedBytes(key) {
        const row = this.db.prepare(`SELECT COALESCE(length(d.body), 0) AS n
      FROM docs_meta m JOIN docs d ON d.rowid = m.rowid WHERE m.doc_key = ?`).get(key);
        return Number(row?.n ?? 0);
    }
    deleteDoc(key) {
        const row = this.db.prepare('SELECT rowid FROM docs_meta WHERE doc_key = ?').get(key);
        if (row === undefined)
            return;
        const body = this.db.prepare('SELECT length(body) AS n FROM docs WHERE rowid = ?').get(row.rowid);
        if (body !== undefined)
            this.totalBytes = Math.max(0, this.totalBytes - Number(body.n));
        this.db.prepare('DELETE FROM docs WHERE rowid = ?').run(row.rowid);
        this.db.prepare('DELETE FROM docs_meta WHERE rowid = ?').run(row.rowid);
    }
    deletePath(path) {
        // Session logs own their refs: deleting the path removes its occurrences.
        const sessionId = basename(dirname(path));
        if (basename(path).startsWith('session.v4.')) {
            try {
                this.db.prepare('DELETE FROM refs WHERE session_id = ?').run(sessionId);
            }
            catch { /* older/foreign databases keep refs best-effort */ }
        }
        try {
            this.db.prepare('DELETE FROM refs_meta WHERE path = ?').run(path);
        }
        catch { /* ignore */ }
        const rows = this.db.prepare(`SELECT m.rowid AS rowid, length(d.body) AS n
      FROM docs_meta m JOIN docs d ON d.rowid = m.rowid WHERE m.path = ?`).all(path);
        const delDoc = this.db.prepare('DELETE FROM docs WHERE rowid = ?');
        const delMeta = this.db.prepare('DELETE FROM docs_meta WHERE rowid = ?');
        for (const row of rows) {
            this.totalBytes = Math.max(0, this.totalBytes - Number(row.n));
            delDoc.run(row.rowid);
            delMeta.run(row.rowid);
        }
    }
    async indexFiles(generation) {
        let after = 0;
        let seen = 0;
        let scanned = 0;
        let capped = false;
        const total = await this.engineEntries();
        if (generation !== this.generation)
            return;
        this.beginPhase('files', total);
        for (;;) {
            if (generation !== this.generation)
                return;
            if (this.engineRescanning())
                throw new Error('engine re-scan started during content build');
            const page = await this.rt.dump(after, 2_000);
            for (const entry of page.entries) {
                if ((++scanned & 0xff) === 0)
                    await this.breathe();
                if (generation !== this.generation)
                    return;
                this.scanEntry(entry.path);
                if (entry.dir || entry.size <= 0 || contentSkipPath(entry.path, this.options.excludes ?? []))
                    continue;
                if (!this.entryIsIndexable(entry.path, entry.name, entry.size))
                    continue;
                if (this.options.maxFiles > 0 && seen >= this.options.maxFiles) {
                    capped = true;
                    break;
                }
                const row = await this.readFileDoc(entry.path, entry.name, entry.mtime);
                if (row === null)
                    continue;
                seen++;
                if (!this.addDoc(row))
                    return;
                this.countIndexed();
                await this.breathe();
            }
            if (capped) {
                this.state.truncated = true;
                break;
            }
            after = page.next;
            if (page.done || page.entries.length === 0)
                break;
        }
    }
    async refreshFiles(generation) {
        const meta = new Map();
        for (const row of this.db.prepare("SELECT doc_key, mtime FROM docs_meta WHERE kind = 'file'").all())
            meta.set(row.doc_key, row.mtime);
        const seen = new Set();
        const deferred = [];
        let after = 0;
        // `maxFiles` counts documents that are actually stored. A file whose read
        // failed is not stored, so it must not consume a slot: counting it here used
        // to stop the loop early (and the deletion pass then removed every trailing
        // document that was never reached). `indexed` only moves on success.
        let indexed = 0;
        let scanned = 0;
        let capped = false;
        const total = await this.engineEntries();
        if (generation !== this.generation)
            return;
        this.beginPhase('files', total);
        for (;;) {
            if (generation !== this.generation)
                return;
            if (this.engineRescanning())
                throw new Error('engine re-scan started during content build');
            const page = await this.rt.dump(after, 2_000);
            for (const entry of page.entries) {
                if ((++scanned & 0xff) === 0)
                    await this.breathe();
                if (generation !== this.generation)
                    return;
                this.scanEntry(entry.path);
                if (entry.dir || entry.size <= 0 || contentSkipPath(entry.path, this.options.excludes ?? []))
                    continue;
                if (!this.entryIsIndexable(entry.path, entry.name, entry.size))
                    continue;
                if (this.options.maxFiles > 0 && indexed >= this.options.maxFiles) {
                    capped = true;
                    break;
                }
                const key = `file:${entry.path}`;
                seen.add(key);
                if (meta.get(key) === entry.mtime) {
                    // Unchanged and already stored: it still occupies one of the slots.
                    indexed++;
                    this.countIndexed();
                    continue;
                }
                if (this.wouldExceed(entry.size, key)) {
                    deferred.push({ path: entry.path, name: entry.name, mtime: entry.mtime, size: entry.size });
                    continue;
                }
                // Read first, replace only on success. A transient read failure must
                // keep the document indexed by the previous refresh, not delete it.
                const row = await this.readFileDoc(entry.path, entry.name, entry.mtime);
                if (row === null)
                    continue;
                if (!this.addDoc(row)) {
                    deferred.push({ path: entry.path, name: entry.name, mtime: entry.mtime, size: entry.size });
                    continue;
                }
                indexed++;
                this.countIndexed();
                await this.breathe();
            }
            if (capped) {
                this.state.truncated = true;
                break;
            }
            after = page.next;
            if (page.done || page.entries.length === 0)
                break;
        }
        // Removing rows for files that disappeared frees budget before the deferred
        // files are retried; otherwise a stale large entry would block new ones.
        for (const key of meta.keys()) {
            if (seen.has(key))
                continue;
            this.deleteDoc(key);
            const deletedPath = docKeyPath(key);
            if (deletedPath !== null)
                this.deleteSymbols(deletedPath);
        }
        for (const entry of deferred) {
            if (generation !== this.generation)
                return;
            if (this.wouldExceed(entry.size, `file:${entry.path}`)) {
                this.state.truncated = true;
                continue;
            }
            const row = await this.readFileDoc(entry.path, entry.name, entry.mtime);
            if (row === null)
                continue;
            if (!this.addDoc(row)) {
                this.state.truncated = true;
                continue;
            }
            this.countIndexed();
            await this.breathe();
        }
    }
    /** Would storing a file of this size overflow the configured body budget? */
    wouldExceed(size, docKey) {
        const cap = this.options.maxTotalBytes ?? 0;
        if (cap <= 0)
            return false;
        const previous = docKey === undefined ? 0 : this.storedBytes(docKey);
        return this.totalBytes - previous + Math.min(size, this.options.maxFileBytes) > cap;
    }
    async readFileDoc(path, name, mtime) {
        if (documentFormat(name) !== null)
            return await this.readDocumentDoc(path, name, mtime);
        let buffer;
        try {
            buffer = await readFile(path);
        }
        catch {
            return null;
        }
        if (buffer.includes(0))
            return null;
        const text = buffer.toString('utf8');
        const body = text.slice(0, this.options.maxFileBytes);
        const symbols = this.collectFileSymbols(path, text, buffer.length);
        return {
            key: `file:${path}`,
            body,
            kind: 'file',
            path,
            title: name,
            sessionId: null,
            messageId: null,
            nodeKey: null,
            mtime,
            format: null,
            ...(symbols === undefined ? {} : { symbols }),
        };
    }
    /** Extract one document body; its format is recorded additively in docs_meta. */
    async readDocumentDoc(path, name, mtime) {
        const format = documentFormat(name);
        if (format === null || !this.extractDocumentsEnabled())
            return null;
        const textCap = Math.max(1, this.options.maxFileBytes);
        const extracted = await extractDocument(path, {
            maxBytes: this.documentMaxBytes(),
            maxChars: textCap,
            onWarning: warning => { this.addWarning(warning); },
        });
        if (extracted === null) {
            // A scanned PDF has no text layer: let the optional OCR hook supply one.
            const ocr = this.options.ocr;
            if (format !== 'pdf' || ocr === undefined)
                return null;
            let recognized;
            try {
                recognized = await ocr(path, format);
            }
            catch {
                recognized = undefined;
            }
            if (recognized === undefined || recognized.trim() === '')
                return null;
            return { key: `file:${path}`, body: recognized.slice(0, textCap), kind: 'file', path, title: name, sessionId: null, messageId: null, nodeKey: null, mtime, format };
        }
        const body = extracted.text.slice(0, textCap);
        if (body.trim() === '')
            return null;
        return { key: `file:${path}`, body, kind: 'file', path, title: name, sessionId: null, messageId: null, nodeKey: null, mtime, format: extracted.format };
    }
    /**
     * Whether one dump entry belongs in this build. Document extraction has its
     * own byte cap: a normal PDF or deck is larger than the text-file limit.
     */
    entryIsIndexable(path, name, size) {
        if (this.options.isIndexable?.(path) === false)
            return false;
        if (documentFormat(name) !== null) {
            if (!this.extractDocumentsEnabled())
                return false;
            if (size > this.documentMaxBytes()) {
                this.addWarning('content-document-too-large');
                return false;
            }
            return true;
        }
        if (size > this.options.maxFileBytes)
            return false;
        return TEXT_EXTENSIONS.has(extname(name).toLowerCase());
    }
    async indexSessions(generation) {
        const files = (await this.sessionCandidates()).filter(file => this.settled(file.mtime));
        this.beginPhase('sessions', files.length);
        for (const file of files) {
            if (generation !== this.generation)
                return;
            this.scanEntry(file.path);
            const read = await this.readSessionText(file);
            if (!read.ok) {
                // A log that cannot be read or decompressed does not contribute rows;
                // the build continues with the remaining sessions.
                this.addWarning('content-session-log-unreadable');
                continue;
            }
            this.deletePath(file.path);
            const indexed = await this.indexSessionText(file, read.text, generation);
            if (!indexed.ok)
                return;
            this.db.prepare('INSERT OR REPLACE INTO sources (path, mtime, cwd) VALUES (?, ?, ?)').run(file.path, file.mtime, indexed.cwd);
            this.countIndexed();
            await this.breathe();
        }
    }
    async refreshSessions(generation) {
        const known = new Map();
        for (const row of this.db.prepare('SELECT path, mtime FROM sources').all())
            known.set(row.path, row.mtime);
        const files = await this.sessionCandidates();
        this.beginPhase('sessions', files.length);
        const present = new Set();
        for (const file of files) {
            if (generation !== this.generation)
                return;
            this.scanEntry(file.path);
            present.add(file.path);
            // The session being written right now is left for a later refresh: keep
            // its existing rows instead of re-reading the whole growing log.
            if (!this.settled(file.mtime))
                continue;
            if (known.get(file.path) === file.mtime)
                continue;
            // Decode the whole log before touching the old rows. On failure keep the
            // previous messages and the previous sources.mtime, so the next refresh
            // retries the same file instead of treating it as empty.
            const read = await this.readSessionText(file);
            if (!read.ok) {
                this.addWarning('content-session-log-unreadable');
                continue;
            }
            this.deletePath(file.path);
            const indexed = await this.indexSessionText(file, read.text, generation);
            if (!indexed.ok)
                return;
            this.db.prepare('INSERT OR REPLACE INTO sources (path, mtime, cwd) VALUES (?, ?, ?)').run(file.path, file.mtime, indexed.cwd);
            this.countIndexed();
            await this.breathe();
        }
        for (const path of known.keys()) {
            if (present.has(path))
                continue;
            this.deletePath(path);
            this.db.prepare('DELETE FROM sources WHERE path = ?').run(path);
        }
    }
    /** Read and decompress one session log completely; no side effects on rows. */
    async readSessionText(file) {
        let text;
        try {
            text = (await zstdDecompressAsync(await readFile(file.path))).toString('utf8');
        }
        catch (error) {
            return { ok: false, error: messageOf(error) };
        }
        return { ok: true, text };
    }
    /** Index one already-decoded session log; the caller owns row replacement. */
    async indexSessionText(file, text, generation) {
        if (generation !== this.generation)
            return { ok: false, cwd: null };
        const sessionId = basename(dirname(file.path));
        this.sessionPaths.set(sessionId, file.path);
        const callNames = new Map();
        let headerCwd = null;
        let title = '';
        let parsed = 0;
        let lineIndex = -1;
        const evidence = [];
        for (const line of text.split('\n')) {
            lineIndex++;
            if (!line)
                continue;
            if ((++parsed & 0xff) === 0) {
                await this.breathe();
                if (generation !== this.generation)
                    return { ok: false, cwd: null };
            }
            let event;
            try {
                event = JSON.parse(line);
            }
            catch {
                continue;
            }
            // Data events are one line each after the header: their sequence is the
            // physical line ordinal minus that header line.
            const eventSeq = Math.max(0, lineIndex - 1);
            const eventData = event.data ?? {};
            const rawMessage = (eventData.message ?? {});
            const refMessageId = String(eventData.id ?? rawMessage.id ?? rawMessage.toolCallId ?? `event-${eventSeq}`);
            if (event.type === 'session') {
                // The first physical line is the session header (not a data envelope):
                // `{ type: 'session', id, cwd?, ... }`. It carries the immutable cwd that
                // authorizes cross-session reads.
                const header = event;
                if (typeof header.cwd === 'string' && header.cwd !== '') {
                    headerCwd = header.cwd;
                    this.sessionCwds.set(sessionId, header.cwd);
                }
                continue;
            }
            const extracted = messageText(event, this.options.includeReasoning === true);
            // Evidence refs are extracted in the same pass as documents; they do not
            // depend on the tool-result indexing flag (URL/spill/attachment metadata
            // lives in the event envelope, not in the FTS body).
            evidence.push(...extractEvidenceRefs(event, sessionId, extracted?.id ?? refMessageId, eventSeq));
            if (extracted !== undefined) {
                evidence.push({
                    refKey: sessionEventRef({ sessionId, seq: eventSeq }), kind: 'session-event', target: sessionId,
                    sha256: null, sessionId, messageId: extracted.id, seq: eventSeq, origin: 'session',
                    title: extracted.titleText.replace(/\s+/g, ' ').slice(0, 120) || null, bytes: null, meta: null,
                });
                if (title === '')
                    title = extracted.titleText.replace(/\s+/g, ' ').slice(0, 90);
                const body = extracted.text.slice(0, SESSION_BODY_BYTES);
                const row = { key: `session:${sessionId}:${extracted.id}`, body, kind: 'session', path: file.path, title: title || sessionId, sessionId, messageId: extracted.id, nodeKey: extracted.nodeKey, mtime: file.mtime };
                if (!this.addDoc(row))
                    return { ok: false, cwd: headerCwd };
                continue;
            }
            if (this.options.includeToolResults === true) {
                // Tool results are their own documents: they can be long, and pairing
                // them with the assistant message would let a huge result evict the
                // answer from the 8KB body cap. The title carries the tool name from
                // the matching tool/call event.
                if (event.type === 'tool/call') {
                    const callId = String((event.data ?? {}).callId ?? '');
                    const name = (event.data ?? {}).name;
                    if (callId !== '' && typeof name === 'string' && name !== '')
                        callNames.set(callId, name);
                    continue;
                }
                if (event.type !== 'tool/result')
                    continue;
                const data = event.data ?? {};
                const message = (data.message ?? {});
                const callId = String(message.toolCallId ?? '');
                const content = message.content;
                if (!Array.isArray(content))
                    continue;
                const body = content
                    .filter((block) => typeof block === 'object' && block !== null
                    && block.type === 'text'
                    && typeof block.text === 'string')
                    .map(block => block.text).join('\n').trim().slice(0, SESSION_BODY_BYTES);
                if (body === '')
                    continue;
                const id = callId !== '' ? callId : `tool-seq-${String(data.seq ?? parsed)}`;
                const toolName = callNames.get(callId) ?? 'tool result';
                const row = { key: `session:${sessionId}:tool-${id}`, body, kind: 'session', path: file.path, title: toolName, sessionId, messageId: id, nodeKey: null, mtime: file.mtime };
                if (!this.addDoc(row))
                    return { ok: false, cwd: headerCwd };
            }
        }
        this.replaceSessionRefs(sessionId, file.path, file.mtime, evidence);
        return { ok: true, cwd: headerCwd };
    }
    /**
     * Session logs to consider, newest first. Archived logs are indexed too:
     * they are excluded from queries (see {@link searchDetailed}) unless the
     * caller or the configuration asks for them, so toggling archived search
     * needs no rebuild.
     */
    async sessionCandidates() {
        const files = await sessionFiles(this.sessionRoots());
        const archived = this.options.includeArchived === true ? new Set() : await archivedSessionIds();
        this.archivedSessions = archived;
        const max = this.options.maxSessions > 0 ? this.options.maxSessions : Number.POSITIVE_INFINITY;
        const out = [];
        for (const file of files) {
            if (out.length >= max)
                break;
            out.push(file);
        }
        return out;
    }
    /** Create the additive `refs`/`refs_meta` tables; true when they were missing. */
    ensureRefsTables() {
        if (this.db === null)
            return false;
        try {
            const names = new Set(this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('refs','refs_meta')").all()
                .map(row => row.name)
                .filter((name) => typeof name === 'string'));
            if (names.has('refs') && names.has('refs_meta'))
                return false;
            this.db.exec(`CREATE TABLE IF NOT EXISTS refs (
        ref_key TEXT NOT NULL, kind TEXT NOT NULL, target TEXT NOT NULL, sha256 TEXT,
        session_id TEXT NOT NULL, message_id TEXT NOT NULL, seq INTEGER,
        origin TEXT NOT NULL, title TEXT, bytes INTEGER, meta TEXT,
        log_mtime INTEGER, indexed_at INTEGER NOT NULL
      )`);
            this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS refs_occ ON refs(ref_key, session_id, message_id)');
            this.db.exec('CREATE INDEX IF NOT EXISTS refs_key ON refs(ref_key)');
            this.db.exec('CREATE INDEX IF NOT EXISTS refs_msg ON refs(session_id, message_id)');
            this.db.exec('CREATE TABLE IF NOT EXISTS refs_meta (path TEXT PRIMARY KEY, log_mtime INTEGER, count INTEGER)');
            return true;
        }
        catch {
            return false;
        }
    }
    /** Replace one session log's ref occurrences after re-reading it. */
    replaceSessionRefs(sessionId, path, mtime, rows) {
        if (this.db === null)
            return;
        try {
            this.db.prepare('DELETE FROM refs WHERE session_id = ?').run(sessionId);
            const insert = this.db.prepare(`INSERT OR IGNORE INTO refs
        (ref_key, kind, target, sha256, session_id, message_id, seq, origin, title, bytes, meta, log_mtime, indexed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
            const now = Date.now();
            for (const row of rows) {
                insert.run(row.refKey, row.kind, row.target, row.sha256, row.sessionId, row.messageId, row.seq, row.origin, row.title, row.bytes, row.meta, mtime, now);
            }
            this.db.prepare('INSERT OR REPLACE INTO refs_meta (path, log_mtime, count) VALUES (?, ?, ?)').run(path, mtime, rows.length);
        }
        catch { /* refs are additive evidence; never fail a content build for them */ }
    }
    /** Add the additive `sources.cwd` column without bumping the schema version. */
    ensureSourcesCwdColumn() {
        if (this.db === null)
            return false;
        try {
            const columns = this.db.prepare('PRAGMA table_info(sources)').all();
            if (columns.some(column => column.name === 'cwd'))
                return false;
            this.db.exec('ALTER TABLE sources ADD COLUMN cwd TEXT');
            return true;
        }
        catch {
            // An older/foreign database keeps path-only behavior.
            return false;
        }
    }
    /** Add the additive docs_meta.format column without bumping the schema version. */
    ensureDocsMetaFormatColumn() {
        if (this.db === null)
            return false;
        try {
            const columns = this.db.prepare('PRAGMA table_info(docs_meta)').all();
            if (columns.some(column => column.name === 'format'))
                return false;
            this.db.exec('ALTER TABLE docs_meta ADD COLUMN format TEXT');
            return true;
        }
        catch {
            // An older/foreign database keeps format-less hits.
            return false;
        }
    }
    /** Create the additive symbols table; true when it was missing. */
    ensureSymbolsTables() {
        if (this.db === null)
            return false;
        try {
            const names = new Set(this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('symbols')").all()
                .map(row => row.name)
                .filter((name) => typeof name === 'string'));
            const created = !names.has('symbols');
            this.db.exec('CREATE TABLE IF NOT EXISTS symbols (path TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, line INTEGER NOT NULL, language TEXT, scope TEXT)');
            this.db.exec('CREATE INDEX IF NOT EXISTS symbols_path ON symbols(path)');
            this.db.exec('CREATE INDEX IF NOT EXISTS symbols_name ON symbols(name)');
            return created;
        }
        catch {
            return false;
        }
    }
    /** Document extraction is on unless an embedder explicitly opted out. */
    extractDocumentsEnabled() {
        return this.options.extractDocuments !== false;
    }
    /** Effective document byte cap; 0/absent means the 20 MiB default. */
    documentMaxBytes() {
        const configured = this.options.extractMaxBytes;
        return configured !== undefined && configured > 0 ? configured : DOCUMENT_EXTRACT_MAX_BYTES;
    }
    /** Symbol indexing is on unless an embedder explicitly opted out. */
    indexSymbolsEnabled() {
        return this.options.indexSymbols !== false;
    }
    /** Effective symbol source-file byte cap; 0/absent means the 512 KiB default. */
    symbolMaxBytes() {
        const configured = this.options.symbolMaxBytes;
        return configured !== undefined && configured > 0 ? configured : SYMBOL_MAX_FILE_BYTES;
    }
    /** Symbols for one code file, or undefined when it is not symbol-indexed. */
    collectFileSymbols(path, text, byteLength) {
        if (!this.indexSymbolsEnabled() || byteLength > this.symbolMaxBytes())
            return undefined;
        const language = languageForPath(path);
        if (language === null)
            return undefined;
        const symbols = extractSymbols(text, language, { maxSymbols: MAX_SYMBOLS_PER_FILE });
        return symbols.length === 0 ? undefined : symbols;
    }
    /** Extract and store symbols for one file while its text is in hand. */
    writeFileSymbols(path, text, byteLength) {
        const symbols = this.collectFileSymbols(path, text, byteLength);
        if (symbols !== undefined)
            this.writeSymbols(path, symbols);
    }
    /** Replace every stored symbol of one file (additive table; failures ignored). */
    writeSymbols(path, symbols) {
        if (this.db === null)
            return;
        try {
            this.db.prepare('DELETE FROM symbols WHERE path = ?').run(path);
            if (symbols.length === 0)
                return;
            const insert = this.db.prepare('INSERT INTO symbols (path, name, kind, line, language, scope) VALUES (?, ?, ?, ?, ?, ?)');
            for (const symbol of symbols)
                insert.run(path, symbol.name, symbol.kind, symbol.line, symbol.language, symbol.scope ?? null);
        }
        catch { /* symbols are additive evidence; never fail a content build for them */ }
    }
    /** Remove every stored symbol of one deleted file. */
    deleteSymbols(path) {
        if (this.db === null || path === '')
            return;
        try {
            this.db.prepare('DELETE FROM symbols WHERE path = ?').run(path);
        }
        catch { /* additive table only */ }
    }
    /** Drop every stored symbol after symbol indexing is turned off. */
    clearSymbols() {
        if (this.db === null)
            return;
        try {
            this.db.exec('DELETE FROM symbols');
        }
        catch { /* additive table only */ }
    }
    /**
     * Apply the symbol-index toggle and run the one-time fill when this database
     * predates the additive table (or symbols were off when it was last built).
     * Called on every incremental path, including the branches that end early,
     * so a finish() can never record symbols=1 without the fill having run.
     */
    async syncSymbols(generation) {
        const wantSymbols = this.indexSymbolsEnabled() ? 1 : 0;
        const storedSymbols = this.readFlag('symbols') ?? 0;
        if (wantSymbols === 1 && storedSymbols !== 1)
            this.needsSymbolBackfill = true;
        if (wantSymbols === 0 && storedSymbols === 1) {
            this.clearSymbols();
            this.writeFlag('symbols', 0);
        }
        if (!this.needsSymbolBackfill)
            return;
        this.needsSymbolBackfill = false;
        await this.backfillSymbols(generation);
    }
    /**
     * One-time fill of the symbol table for a database built before symbols
     * existed (or before the user enabled them). Only paths already stored in
     * docs_meta are read, so it never walks the disk again.
     */
    async backfillSymbols(generation) {
        if (this.db === null || !this.indexSymbolsEnabled())
            return;
        let rows;
        try {
            rows = this.db.prepare("SELECT path FROM docs_meta WHERE kind = 'file'").all();
        }
        catch {
            return;
        }
        const byteLimit = this.symbolMaxBytes();
        this.beginPhase('files', rows.length);
        for (const row of rows) {
            if (generation !== this.generation)
                return;
            const path = row.path;
            if (typeof path !== 'string' || path === '' || languageForPath(path) === null)
                continue;
            if (this.options.isIndexable?.(path) === false)
                continue;
            this.scanEntry(path);
            try {
                const info = await stat(path);
                if (!info.isFile() || info.size <= 0 || info.size > byteLimit)
                    continue;
                const text = (await readFile(path)).toString('utf8');
                this.writeFileSymbols(path, text, info.size);
            }
            catch {
                continue;
            }
            await this.breathe();
        }
    }
    /**
     * Every stored spelling one indexed path may have: exactly as given, its
     * canonical real path, and the configured root's raw spelling. The engine
     * indexes files in the spelling of the configured root, which is not always
     * the real path (macOS `/var` → `/private/var`, a Windows short name, an
     * operator-configured symlink), while tools authorize and report canonical
     * paths. Symbols and docs_meta lookups accept any spelling, so a caller can
     * pass either one and databases written before this resolution stay readable.
     */
    pathSpellings(path) {
        const spellings = [];
        const add = (value) => {
            if (typeof value !== 'string' || value === '')
                return;
            if (!spellings.includes(value))
                spellings.push(value);
        };
        add(path);
        const canonical = canonicalFsPath(path);
        add(canonical);
        const rawRoots = this.rt.roots;
        if (!Array.isArray(rawRoots))
            return spellings;
        for (const rawRoot of rawRoots) {
            if (typeof rawRoot !== 'string' || rawRoot === '')
                continue;
            const canonicalRoot = canonicalFsPath(rawRoot);
            if (canonicalRoot === canonical) {
                add(rawRoot);
                continue;
            }
            if (!pathUnderRoot(canonicalRoot, canonical))
                continue;
            const suffix = canonical.slice(canonicalRoot.length).replace(/^[\\/]+/, '');
            add(suffix === '' ? rawRoot : join(rawRoot, suffix));
        }
        return spellings;
    }
    /** A `column IN (…)` fragment and its values covering every spelling of one path. */
    pathMatch(column, path) {
        const spellings = this.pathSpellings(path);
        // An empty path has no spelling; `= NULL` is valid SQL and matches nothing.
        if (spellings.length === 0)
            return { sql: column + ' = NULL', values: [] };
        return { sql: column + ' IN (' + spellings.map(() => '?').join(', ') + ')', values: spellings };
    }
    /**
     * Indexed document format for one file (pdf, docx, ...); undefined for plain
     * text, unknown paths and databases built before extraction existed.
     */
    docFormat(path) {
        if (this.db === null || path === '')
            return undefined;
        try {
            const match = this.pathMatch('path', path);
            const row = this.db.prepare('SELECT format FROM docs_meta WHERE ' + match.sql + ' AND format IS NOT NULL LIMIT 1').get(...match.values);
            return typeof row?.format === 'string' && row.format !== '' ? row.format : undefined;
        }
        catch {
            return undefined;
        }
    }
    /**
     * Every symbol stored for one path, in line order.
     * @param path - absolute file path as stored by the file index, or any other
     *   spelling of it (canonical real path / configured-root path).
     * @returns symbols for the file; empty when it was not symbol-indexed.
     */
    outline(path) {
        if (this.db === null || path === '')
            return [];
        try {
            const match = this.pathMatch('path', path);
            const rows = this.db.prepare('SELECT DISTINCT name, kind, line, language, scope FROM symbols WHERE ' + match.sql + ' ORDER BY line, name').all(...match.values);
            return toSymbols(rows);
        }
        catch {
            return [];
        }
    }
    /**
     * Find symbols by name. Exact matches rank before prefix matches, then
     * substring matches.
     * @param name - symbol name or fragment.
     * @param limit - maximum rows (default 50, at most 200).
     * @returns path/line/kind/name rows across indexed files.
     */
    findSymbols(name, limit = 50) {
        if (this.db === null)
            return [];
        const query = name.trim();
        if (query === '')
            return [];
        const bounded = Math.max(1, Math.min(200, Math.trunc(limit)));
        const escaped = escapeLike(query);
        try {
            const rows = this.db.prepare("SELECT path, name, kind, line, language, scope FROM symbols WHERE name = ? OR name LIKE ? ESCAPE '\\' ORDER BY (name = ?) DESC, (name LIKE ? ESCAPE '\\') DESC, name, path, line LIMIT ?")
                .all(query, '%' + escaped + '%', query, escaped + '%', bounded);
            const matches = [];
            for (const row of rows) {
                const path = row.path;
                if (typeof path !== 'string' || path === '')
                    continue;
                const symbol = toSymbols([row])[0];
                if (symbol === undefined)
                    continue;
                matches.push({
                    path,
                    line: symbol.line,
                    kind: symbol.kind,
                    name: symbol.name,
                    language: symbol.language,
                    ...(symbol.scope === undefined ? {} : { scope: symbol.scope }),
                });
            }
            return matches;
        }
        catch {
            return [];
        }
    }
    /**
     * Compact repository map for agent context: files ranked by symbol count,
     * cut to a token budget that is estimated as characters / 4. A file is
     * included whole; a file that does not fit is skipped so smaller lower-ranked
     * files can still make it.
     * @param roots - directory prefixes to include; empty means every indexed file.
     * @param tokenBudget - approximate token budget; non-positive returns nothing.
     * @returns included files with their symbols, most structural first.
     */
    repoMap(roots, tokenBudget) {
        if (this.db === null)
            return [];
        const budget = Math.trunc(tokenBudget);
        if (!Number.isFinite(budget) || budget <= 0)
            return [];
        let rows;
        try {
            rows = this.db.prepare('SELECT path, name, kind, line, language, scope FROM symbols ORDER BY path, line').all();
        }
        catch {
            return [];
        }
        // Both sides of the containment check are canonicalized: the stored path
        // may use the configured-root spelling (symlinked temp dir, Windows short
        // name) while the requested root may be its real path, or the other way
        // around. Rows that match on the raw spelling skip the realpath syscall.
        const rootSpellings = [];
        const addRootSpelling = (root) => {
            if (typeof root !== 'string' || root === '' || rootSpellings.includes(root))
                return;
            rootSpellings.push(root);
        };
        for (const root of roots) {
            if (typeof root !== 'string' || root === '')
                continue;
            addRootSpelling(root);
            addRootSpelling(canonicalFsPath(root));
        }
        const canonicalPaths = new Map();
        const inRoots = (storedPath) => {
            if (roots.length === 0)
                return true;
            if (rootSpellings.length === 0)
                return false;
            if (pathWithinRoots(storedPath, rootSpellings))
                return true;
            let canonical = canonicalPaths.get(storedPath);
            if (canonical === undefined) {
                canonical = canonicalFsPath(storedPath);
                canonicalPaths.set(storedPath, canonical);
            }
            return canonical !== storedPath && pathWithinRoots(canonical, rootSpellings);
        };
        const byPath = new Map();
        for (const row of rows) {
            const path = row.path;
            if (typeof path !== 'string' || path === '' || !inRoots(path))
                continue;
            const symbol = toSymbols([row])[0];
            if (symbol === undefined)
                continue;
            const symbols = byPath.get(path);
            if (symbols === undefined)
                byPath.set(path, [symbol]);
            else
                symbols.push(symbol);
        }
        const candidates = [...byPath.entries()].map(([path, symbols]) => ({ path, symbols, tokens: estimateSymbolTokens(path, symbols) }));
        candidates.sort((left, right) => right.symbols.length - left.symbols.length || left.path.localeCompare(right.path));
        const included = [];
        let used = 0;
        for (const candidate of candidates) {
            if (used + candidate.tokens > budget)
                continue;
            included.push({ path: candidate.path, symbols: candidate.symbols });
            used += candidate.tokens;
        }
        return included;
    }
    /**
     * Stored document formats for the given file paths (only extracted
     * documents have one). Unlike hit enrichment this is safe to call before a
     * tool schema declares the field.
     * @param paths - candidate file paths.
     * @returns path to format map; plain text and unknown paths are absent.
     */
    formatsFor(paths) {
        const formats = new Map();
        if (this.db === null)
            return formats;
        const unique = [...new Set(paths.filter(path => path !== ''))];
        if (unique.length === 0)
            return formats;
        // Query every spelling of each requested path and answer under the caller's
        // own spelling too, so `formatsFor([canonical]).get(canonical)` works even
        // when the row was stored with the configured-root spelling.
        const callerBySpelling = new Map();
        const spellings = [];
        for (const path of unique) {
            for (const spelling of this.pathSpellings(path)) {
                if (!spellings.includes(spelling))
                    spellings.push(spelling);
                if (!callerBySpelling.has(spelling))
                    callerBySpelling.set(spelling, path);
            }
        }
        try {
            const placeholders = spellings.map(() => '?').join(', ');
            const rows = this.db.prepare('SELECT path, format FROM docs_meta WHERE path IN (' + placeholders + ') AND format IS NOT NULL').all(...spellings);
            for (const row of rows) {
                if (typeof row.path !== 'string' || row.path === '' || typeof row.format !== 'string' || row.format === '')
                    continue;
                formats.set(row.path, row.format);
                const callerPath = callerBySpelling.get(row.path);
                if (callerPath !== undefined)
                    formats.set(callerPath, row.format);
            }
        }
        catch { /* older databases keep an empty map */ }
        return formats;
    }
    /** Attach formats only when the caller opted in (tool schemas must declare it). */
    enrichHitFormats(result) {
        if (this.options.attachHitFormats !== true)
            return result;
        if (this.db === null || result.hits.length === 0)
            return result;
        const formats = this.formatsFor(result.hits.filter(hit => hit.kind === 'file').map(hit => hit.path));
        if (formats.size === 0)
            return result;
        return {
            ...result,
            hits: result.hits.map(hit => {
                if (hit.kind !== 'file')
                    return hit;
                const format = formats.get(hit.path);
                return format === undefined ? hit : { ...hit, format };
            }),
        };
    }
    /** The session header's cwd for one indexed session, when known. */
    sessionCwd(sessionId) {
        return this.sessionCwds.get(sessionId);
    }
    /**
     * Session ids the caller may read: its own session plus sessions whose
     * header cwd equals the caller cwd (the same rule as DSH's
     * `tool-session-query` workspace authorization).
     * @param callerCwd - caller session cwd (immutable header value).
     * @param callerSessionId - caller session id.
     * @returns allowed session ids; empty when the caller has no identity.
     */
    authorizedSessionIds(callerCwd, callerSessionId) {
        const allowed = new Set();
        if (callerSessionId !== undefined && callerSessionId !== '')
            allowed.add(callerSessionId);
        // Ref resolution (locator_resolve/cite) can run before any content search
        // started the lazy build. Open the existing database path map first so the
        // workspace rule does not degrade to "own session only" on a cold start.
        if (this.db === null && this.sessionCwds.size === 0) {
            try {
                this.open(false);
            }
            catch { /* incompatible/foreign DB keeps own-session only */ }
        }
        if (callerCwd === undefined || callerCwd === '')
            return allowed;
        for (const [sessionId, cwd] of this.sessionCwds) {
            if (cwd === callerCwd)
                allowed.add(sessionId);
        }
        return allowed;
    }
    /**
     * The mtime the index stored for one document (file or session message).
     * File paths are matched under every spelling of the path, so a caller that
     * authorized a canonical path still finds a row stored with the
     * configured-root spelling.
     */
    indexedMtime(kind, path, messageId) {
        if (this.db === null)
            return undefined;
        if (kind === 'session' && (messageId === undefined || messageId === ''))
            return undefined;
        const messageKey = messageId ?? '';
        try {
            let row;
            if (kind === 'file') {
                const match = this.pathMatch('path', path);
                row = this.db.prepare('SELECT mtime FROM docs_meta WHERE kind = ? AND ' + match.sql + ' LIMIT 1').get(kind, ...match.values);
            }
            else {
                row = this.db.prepare(`SELECT m.mtime AS mtime FROM docs_meta m JOIN docs d ON d.rowid = m.rowid
            WHERE m.kind = 'session' AND d.session_id = ? AND d.message_id = ? LIMIT 1`).get(basename(dirname(path)), messageKey);
            }
            return row?.mtime === undefined ? undefined : Number(row.mtime);
        }
        catch {
            return undefined;
        }
    }
    /** The stored (≤8KB) body for one indexed session message. */
    sessionBody(sessionId, messageId) {
        if (this.db === null)
            return undefined;
        try {
            const row = this.db.prepare('SELECT body FROM docs WHERE kind = ? AND session_id = ? AND message_id = ? LIMIT 1').get('session', sessionId, messageId);
            return typeof row?.body === 'string' ? row.body : undefined;
        }
        catch {
            return undefined;
        }
    }
    /** One stored evidence-ref occurrence. */
    refsForMessage(sessionId, messageId) {
        if (this.db === null)
            return [];
        try {
            return this.db.prepare(`SELECT ref_key AS refKey, kind, target, sha256, session_id AS sessionId,
          message_id AS messageId, seq, origin, title, bytes, meta, log_mtime AS logMtime, indexed_at AS indexedAt
        FROM refs WHERE session_id = ? AND message_id = ? ORDER BY seq, kind`).all(sessionId, messageId);
        }
        catch {
            return [];
        }
    }
    /** All authorized-agnostic occurrences of one ref key (bounded). */
    refsFor(refKey, limit = 50) {
        if (this.db === null)
            return [];
        try {
            return this.db.prepare(`SELECT ref_key AS refKey, kind, target, sha256, session_id AS sessionId,
          message_id AS messageId, seq, origin, title, bytes, meta, log_mtime AS logMtime, indexed_at AS indexedAt
        FROM refs WHERE ref_key = ? ORDER BY indexed_at DESC LIMIT ?`).all(refKey, Math.max(1, Math.min(200, limit)));
        }
        catch {
            return [];
        }
    }
    /** Occurrence counts for the status tool. */
    refCount() {
        if (this.db === null)
            return { refs: 0, occurrences: 0 };
        try {
            const row = this.db.prepare('SELECT COUNT(DISTINCT ref_key) AS refs, COUNT(*) AS occurrences FROM refs').get();
            return { refs: Number(row?.refs ?? 0), occurrences: Number(row?.occurrences ?? 0) };
        }
        catch {
            return { refs: 0, occurrences: 0 };
        }
    }
    /**
     * Distinct evidence refs grouped by kind, for `locator_status`. One GROUP BY
     * keeps the status call cheap; a database without the additive tables reports
     * zeros instead of failing.
     * @returns total distinct refs plus one count per ref kind.
     */
    refsByKind() {
        if (this.db === null)
            return { total: 0, byKind: {} };
        try {
            const rows = this.db.prepare('SELECT kind, COUNT(DISTINCT ref_key) AS n FROM refs GROUP BY kind').all();
            const byKind = {};
            let total = 0;
            for (const row of rows) {
                if (typeof row.kind !== 'string' || row.kind === '')
                    continue;
                const count = Number(row.n ?? 0);
                if (!Number.isFinite(count) || count <= 0)
                    continue;
                byKind[row.kind] = count;
                total += count;
            }
            return { total, byKind };
        }
        catch {
            return { total: 0, byKind: {} };
        }
    }
    /**
     * Persist the lazy "missing" marker for one ref across all its occurrences.
     * Only the first miss writes; later resolves read the stored meta instead of
     * re-statting the spill file / attachment store.
     * @param refKey - complete ref string of the missing target.
     * @returns true when this call wrote a new marker, false when it was cached.
     */
    markRefMissing(refKey) {
        if (this.db === null || refKey === '')
            return false;
        try {
            const rows = this.db.prepare('SELECT rowid AS rowid, meta AS meta FROM refs WHERE ref_key = ?').all(refKey);
            if (rows.length === 0)
                return false;
            const update = this.db.prepare('UPDATE refs SET meta = ? WHERE rowid = ?');
            let marked = false;
            for (const row of rows) {
                if (refMetaMissing(row.meta))
                    continue;
                update.run(markRefMeta(row.meta), row.rowid);
                marked = true;
            }
            return marked;
        }
        catch {
            return false;
        }
    }
    /**
     * Merge one JSON patch into every occurrence's refs.meta (bounded, additive).
     * Used by URL-ref freshness (ETag / Last-Modified / body sha256) so a later
     * resolve can issue a conditional request. A patch field overwrites a stale
     * field of the same name; the lazy missing marker is always preserved. A
     * patch that cannot fit the bounded column is skipped for that occurrence
     * instead of being truncated into invalid JSON.
     * @param refKey - complete ref string whose occurrences are updated.
     * @param patch - JSON-safe fields to store (nested objects are allowed).
     * @returns true when at least one occurrence was updated.
     */
    setRefMeta(refKey, patch) {
        if (this.db === null || refKey === '')
            return false;
        const entries = Object.entries(patch);
        if (entries.length === 0)
            return false;
        try {
            const rows = this.db.prepare('SELECT rowid AS rowid, meta AS meta FROM refs WHERE ref_key = ?').all(refKey);
            if (rows.length === 0)
                return false;
            const update = this.db.prepare('UPDATE refs SET meta = ? WHERE rowid = ?');
            let written = false;
            for (const row of rows) {
                const merged = mergeRefMeta(row.meta, entries);
                if (merged === null)
                    continue;
                update.run(merged, row.rowid);
                written = true;
            }
            return written;
        }
        catch {
            return false;
        }
    }
    /**
     * Stored session-event refs for one page of indexed message ids, used by
     * `locator_find` to attach the event seq/ref to session hits.
     * @param sessionId - owning session.
     * @param messageIds - message ids from the current hit page.
     * @returns message id → { seq, ref }; ids without a stored event are absent.
     */
    sessionEventRefs(sessionId, messageIds) {
        const out = new Map();
        if (this.db === null || sessionId === '')
            return out;
        const unique = [...new Set(messageIds.filter(id => id !== ''))];
        if (unique.length === 0)
            return out;
        try {
            const placeholders = unique.map(() => '?').join(', ');
            const rows = this.db.prepare(`SELECT message_id AS messageId, ref_key AS refKey, seq AS seq
        FROM refs WHERE session_id = ? AND kind = 'session-event' AND message_id IN (${placeholders})
        ORDER BY seq`).all(sessionId, ...unique);
            for (const row of rows) {
                if (typeof row.messageId !== 'string' || typeof row.refKey !== 'string' || typeof row.seq !== 'number')
                    continue;
                if (!out.has(row.messageId))
                    out.set(row.messageId, { seq: row.seq, ref: row.refKey });
            }
        }
        catch { /* older/foreign databases keep hits without event refs */ }
        return out;
    }
    /**
     * Read one event by sequence from the local session log, for refs resolution.
     * The header is the first physical line, so event `seq` is line `seq + 1`.
     * @param sessionId - session id.
     * @param seq - event sequence.
     * @param maxChars - cap on the returned JSON line.
     * @returns the raw event line, or undefined when the session/log is unavailable.
     */
    async sessionEventBody(sessionId, seq, maxChars = 16 * 1024) {
        if (!Number.isInteger(seq) || seq < 0)
            return undefined;
        const path = this.sessionPaths.get(sessionId);
        if (path === undefined)
            return undefined;
        try {
            const info = await stat(path);
            const read = await this.readSessionText({ path, mtime: info.mtimeMs });
            if (!read.ok)
                return undefined;
            const lines = read.text.split('\n');
            const line = lines[seq + 1];
            if (line === undefined || line === '')
                return undefined;
            return line.slice(0, Math.max(128, maxChars));
        }
        catch {
            return undefined;
        }
    }
    /** The mtime recorded for one session log in `sources`. */
    sessionIndexedMtime(sessionId) {
        if (this.db === null)
            return undefined;
        try {
            const row = this.db.prepare('SELECT mtime FROM sources WHERE path = ?').get(this.sessionPaths.get(sessionId) ?? '');
            return row?.mtime === undefined ? undefined : Number(row.mtime);
        }
        catch {
            return undefined;
        }
    }
    sessionRoots() {
        if (this.options.sessionDirs !== undefined)
            return this.options.sessionDirs;
        return [join(dshHome(), 'sessions')];
    }
    async search(query, limit, options) {
        const result = await this.searchDetailed(query, limit, options ?? {});
        return options === undefined ? result.hits : result;
    }
    async searchDetailed(query, limit, options) {
        const resolvedOptions = this.resolveSession(options);
        const extraWarnings = [];
        let resolved;
        if (resolvedOptions === null) {
            // The caller's session is not indexed yet (active sessions are indexed
            // only after they settle). `locator_find` workspace scope asks for file
            // hits to keep working in that window instead of returning nothing.
            if (options.sessionUnavailable !== 'files-only')
                return emptySearchResult(['unknown-session']);
            const fallback = { ...options, sessionPath: null, excludeSessions: true };
            delete fallback.sessionId;
            resolved = fallback;
            extraWarnings.push('unknown-session');
        }
        else {
            resolved = resolvedOptions;
        }
        const withWarnings = (result) => extraWarnings.length === 0
            ? result
            : { ...result, warnings: [...new Set([...extraWarnings, ...result.warnings])] };
        const includeArchived = options.includeArchived === true || this.options.includeArchived === true;
        if (!includeArchived && this.archivedSessions.size > 0) {
            resolved = { ...resolved, excludeArchivedSessions: [...this.archivedSessions] };
        }
        if (this.db === null)
            return withWarnings(emptySearchResult());
        if (!this.databaseIsCurrent()) {
            this.recoverExternal();
            return withWarnings(emptySearchResult());
        }
        // Direct embedders run in-process by design (searchWorker is off).
        if (this.options.searchWorker !== true)
            return withWarnings(this.enrichHitFormats(this.searchSync(query, limit, resolved, false)));
        if (!this.ensureWorker()) {
            // The worker could not be created at all: the one allowed sync path.
            return withWarnings(this.enrichHitFormats(this.searchSync(query, limit, resolved, true)));
        }
        return withWarnings(this.enrichHitFormats(await this.searchInWorker(query, limit, resolved)));
    }
    /** Run one query on the worker; timeout/protocol errors are final results. */
    async searchInWorker(query, limit, options) {
        const worker = this.worker;
        if (worker === null)
            return workerFailureResult('content-search-worker-failed');
        const id = ++this.workerSeq;
        const response = new Promise(resolve => { this.pending.set(id, resolve); });
        const timeoutMs = Math.max(1, this.options.searchWorkerTimeoutMs ?? WORKER_TIMEOUT_MS);
        let timer;
        const timeout = new Promise(resolve => {
            timer = setTimeout(() => {
                if (!this.pending.delete(id))
                    return;
                // A wedged worker is thrown away; the next query gets a fresh one. The
                // current query is reported as timed out, never re-run here.
                if (this.worker === worker) {
                    this.worker = null;
                    void worker.terminate();
                }
                resolve(workerFailureResult('content-search-timeout'));
            }, timeoutMs);
        });
        try {
            worker.postMessage({ id, query, limit, options });
        }
        catch {
            if (this.pending.delete(id)) {
                if (timer !== undefined)
                    clearTimeout(timer);
                return workerFailureResult('content-search-worker-failed');
            }
        }
        try {
            return await Promise.race([response, timeout]);
        }
        finally {
            if (timer !== undefined)
                clearTimeout(timer);
        }
    }
    /** Map a request's sessionId onto the indexed session log path. */
    resolveSession(options) {
        if (options.sessionPath !== undefined && options.sessionPath !== null)
            return options;
        if (options.sessionId === undefined || options.sessionId === '')
            return { ...options, sessionPath: null };
        const path = this.sessionPaths.get(options.sessionId);
        if (path === undefined)
            return null;
        return { ...options, sessionPath: path };
    }
    /**
     * In-process query path. When `degraded` is set (worker creation failed) the
     * options are tightened so this rare path cannot spend an unbounded amount of
     * host-thread time counting matches.
     */
    searchSync(query, limit, options, degraded) {
        if (this.db === null)
            return emptySearchResult();
        const effective = degraded ? budgetedSearchOptions(options) : options;
        try {
            const result = searchContent(this.db, query, limit, effective);
            if (!degraded)
                return result;
            return { ...result, warnings: [...new Set(['content-search-in-process', ...result.warnings])] };
        }
        catch (error) {
            this.state.error = messageOf(error);
            return emptySearchResult();
        }
    }
}
/** Default deadline for one worker query. */
const WORKER_TIMEOUT_MS = 5_000;
/** Counting cap used by the rare in-process fallback. */
const IN_PROCESS_COUNT_LIMIT = 200;
/** Tighten a query for the in-process fallback: bounded counting only. */
function budgetedSearchOptions(options) {
    return {
        ...options,
        count: options.count === 'none' ? 'none' : 'bounded',
        countLimit: Math.min(options.countLimit ?? IN_PROCESS_COUNT_LIMIT, IN_PROCESS_COUNT_LIMIT),
    };
}
/** Whether a value looks like a complete worker search result. */
function isContentSearchResult(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const record = value;
    if (!Array.isArray(record.hits) || !Array.isArray(record.warnings))
        return false;
    const count = record.count;
    if (typeof count !== 'object' || count === null)
        return false;
    const kind = count.kind;
    return kind === 'exact' || kind === 'bounded' || kind === 'unknown';
}
/** Result for a failed worker query; carries an explicit error code. */
function workerFailureResult(error) {
    return { hits: [], count: { value: 0, kind: 'unknown' }, warnings: [error], error };
}
/** Result used when a content query could not run at all. */
function emptySearchResult(warnings = []) {
    return { hits: [], count: { value: 0, kind: 'unknown' }, warnings };
}
function dshHome() {
    return process.env.DSH_HOME || join(homedir(), '.dsh');
}
/** Archived session ids recorded by the Workspace registry; empty when absent. */
async function archivedSessionIds() {
    try {
        const raw = await readFile(join(dshHome(), 'storages', 'workspace.json'), 'utf8');
        const parsed = JSON.parse(raw);
        const ids = parsed.global?.archivedSessionIds;
        return new Set(Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : []);
    }
    catch {
        return new Set();
    }
}
/** Conversation node key format used by the host DOM (`${kind.length}:${kind}${id}`). */
function conversationNodeKey(kind, id) {
    return `${kind.length}:${kind}${id}`;
}
/** The normalized URL plus its identity hash. */
function urlIdentity(raw) {
    const ref = urlRef(raw);
    const target = normalizeUrl(raw);
    return { ref, target, sha256: createHash('sha256').update(target).digest('hex') };
}
/** Longest `refs.meta` JSON string this release writes. */
const REF_META_LIMIT = 400;
/** Bounded JSON metadata column for one ref. */
function refMeta(value) {
    const text = JSON.stringify(value);
    return text.length > REF_META_LIMIT ? `${text.slice(0, REF_META_LIMIT - 3)}...` : text;
}
/** Whether a stored ref meta JSON already carries the lazy missing marker. */
function refMetaMissing(meta) {
    if (meta === null || meta === '')
        return false;
    try {
        const parsed = JSON.parse(meta);
        return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
            && parsed.missing === true;
    }
    catch {
        return false;
    }
}
/**
 * Merge the lazy missing marker into one ref's stored meta JSON. The marker is
 * written first and optional metadata is dropped as needed, so a bounded column
 * never truncates it into unparseable JSON.
 */
function markRefMeta(previous) {
    const extras = new Map();
    if (previous !== null) {
        try {
            const parsed = JSON.parse(previous);
            if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
                for (const [key, value] of Object.entries(parsed)) {
                    if (key !== 'missing' && key !== 'missingAt')
                        extras.set(key, value);
                }
            }
        }
        catch { /* only the marker survives */ }
    }
    const entries = [...extras.entries()];
    for (let keep = entries.length; keep >= 0; keep--) {
        const text = JSON.stringify({ missing: true, missingAt: Date.now(), ...Object.fromEntries(entries.slice(0, keep)) });
        if (text.length <= REF_META_LIMIT)
            return text;
    }
    return JSON.stringify({ missing: true, missingAt: Date.now() });
}
/** Map raw symbol rows to CodeSymbol values, dropping malformed rows. */
function toSymbols(rows) {
    const symbols = [];
    for (const row of rows) {
        if (typeof row.name !== 'string' || row.name === '' || typeof row.kind !== 'string' || typeof row.line !== 'number')
            continue;
        const symbol = { name: row.name, kind: row.kind, line: row.line, language: typeof row.language === 'string' ? row.language : '' };
        if (typeof row.scope === 'string' && row.scope !== '')
            symbol.scope = row.scope;
        symbols.push(symbol);
    }
    return symbols;
}
/** Path stored behind a file document key ("file:<path>"), or null. */
function docKeyPath(key) {
    return key.startsWith('file:') ? key.slice(5) : null;
}
const WINDOWS_PATHS = process.platform === 'win32';
/**
 * Canonical real path so every comparison uses one spelling: a symlinked
 * temporary directory (`/var` → `/private/var` on macOS), a Windows short
 * name (`RUNNER~1`) or a differently-cased drive path cannot make the same
 * file look like two different files. A missing target (deleted file, dangling
 * symlink) falls back to a lexical `resolve`, which keeps lookups usable
 * without inventing a match.
 */
function canonicalFsPath(path) {
    if (typeof path !== 'string' || path === '')
        return '';
    try {
        return realpathSync.native(path);
    }
    catch { /* missing target: compare lexically */ }
    try {
        return resolve(path);
    }
    catch {
        return path;
    }
}
/** Slash-normalized path for comparison; Windows folds case like the filesystem. */
function comparablePath(path) {
    const slashed = path.replace(/\\/g, '/');
    const trimmed = slashed.length > 1 ? slashed.replace(/\/+$/, '') : slashed;
    const normalized = trimmed === '' ? '/' : trimmed;
    return WINDOWS_PATHS ? normalized.toLowerCase() : normalized;
}
/** Whether `target` is `root` itself or lives below it (filesystem comparison rules). */
function pathUnderRoot(root, target) {
    const normalizedRoot = comparablePath(root);
    if (normalizedRoot === '')
        return false;
    const normalizedTarget = comparablePath(target);
    if (normalizedTarget === normalizedRoot)
        return true;
    if (normalizedRoot === '/')
        return normalizedTarget.startsWith('/');
    return normalizedTarget.startsWith(normalizedRoot + '/');
}
/**
 * Whether a path is inside one of the roots. Slash and backslash are
 * interchangeable and Windows compares case-insensitively, matching what the
 * filesystem itself does; callers may pass either the raw or the canonical
 * spelling of a root.
 */
function pathWithinRoots(path, roots) {
    if (roots.length === 0)
        return true;
    for (const root of roots) {
        if (typeof root !== 'string' || root === '')
            continue;
        if (pathUnderRoot(root, path))
            return true;
    }
    return false;
}
/**
 * Merge a JSON patch into one bounded refs.meta value. The lazy missing marker
 * is always preserved, patch fields rank before older extras when the column
 * limit forces something out, and null means "does not fit; leave the row
 * alone" so the column never holds unparseable truncated JSON.
 */
function mergeRefMeta(previous, entries) {
    const marker = new Map();
    const older = new Map();
    if (previous !== null && previous !== '') {
        try {
            const parsed = JSON.parse(previous);
            if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
                for (const [key, value] of Object.entries(parsed)) {
                    if (key === 'missing' || key === 'missingAt')
                        marker.set(key, value);
                    else
                        older.set(key, value);
                }
            }
        }
        catch { /* unreadable metadata gives way to the patch */ }
    }
    const patched = [];
    for (const [key, value] of entries) {
        if (key === 'missing' || key === 'missingAt')
            continue;
        older.delete(key);
        patched.push([key, value]);
    }
    const previousExtras = [...older.entries()];
    for (let keep = previousExtras.length; keep >= 0; keep--) {
        const merged = {};
        for (const [key, value] of marker)
            merged[key] = value;
        for (const [key, value] of patched)
            merged[key] = value;
        for (const [key, value] of previousExtras.slice(0, keep))
            merged[key] = value;
        const text = JSON.stringify(merged);
        if (text.length <= REF_META_LIMIT)
            return text;
    }
    return null;
}
/**
 * Extract the non-session-event evidence refs carried by one session log event:
 * `web_search`/`web_fetch` URLs (from `data.meta`), spill locators (from the
 * tool-result text notice) and attachment digests (from user message blocks).
 * Session-event refs are added by the caller for events that became documents.
 * @param event - parsed session event line.
 * @param sessionId - owning session.
 * @param messageId - message/call id the occurrence belongs to.
 * @param seq - event sequence (the line ordinal minus the header line).
 * @returns ref rows ready for `refs` (deduplication happens at insert time).
 */
export function extractEvidenceRefs(event, sessionId, messageId, seq) {
    const out = [];
    const data = event.data ?? {};
    if (event.type === 'tool/result') {
        const message = (data.message ?? {});
        const meta = (data.meta ?? {});
        const sources = Array.isArray(meta.sources) ? meta.sources : [];
        for (const source of sources) {
            if (typeof source !== 'object' || source === null)
                continue;
            const record = source;
            if (typeof record.url !== 'string' || record.url === '')
                continue;
            const identity = urlIdentity(record.url);
            out.push({
                refKey: identity.ref, kind: 'url', target: identity.target, sha256: identity.sha256,
                sessionId, messageId, seq: null, origin: 'web_search',
                title: typeof record.title === 'string' ? record.title.slice(0, 200) : null,
                bytes: null,
                meta: refMeta({ snippet: typeof record.snippet === 'string' ? record.snippet.slice(0, 200) : undefined, publishedAt: record.publishedAt }),
            });
        }
        if (typeof meta.url === 'string' && meta.url !== '') {
            const identity = urlIdentity(meta.url);
            out.push({
                refKey: identity.ref, kind: 'url', target: identity.target, sha256: identity.sha256,
                sessionId, messageId, seq: null, origin: 'web_fetch',
                title: typeof meta.title === 'string' ? meta.title.slice(0, 200) : null,
                bytes: null,
                meta: refMeta({ statusCode: meta.statusCode, truncated: meta.truncated }),
            });
        }
        const content = message.content;
        if (Array.isArray(content)) {
            const text = content
                .filter((block) => typeof block === 'object' && block !== null
                && block.type === 'text'
                && typeof block.text === 'string')
                .map(block => block.text)
                .join('\n');
            const locator = /Full formatted result stored at:\s*(\S+?)\.?\s*Use read/.exec(text)?.[1];
            if (locator !== undefined) {
                const bytes = Number(/Omitted (\d+) bytes/.exec(text)?.[1] ?? '');
                out.push({
                    refKey: spillRef({ path: locator, sessionId, seq }), kind: 'spill', target: locator, sha256: null,
                    sessionId, messageId, seq, origin: 'spill', title: null,
                    bytes: Number.isFinite(bytes) ? bytes : null,
                    meta: null,
                });
            }
        }
        return out;
    }
    if (event.type === 'user/message' && Array.isArray(data.content)) {
        for (const block of data.content) {
            if (typeof block !== 'object' || block === null)
                continue;
            const record = block;
            if (record.type !== 'image' && record.type !== 'file')
                continue;
            const attachment = (record.attachment ?? {});
            const id = typeof attachment.attachmentId === 'string' ? attachment.attachmentId : '';
            const match = /^sha256:([0-9a-f]{64})$/.exec(id);
            if (match === null)
                continue;
            const sha256 = match[1];
            out.push({
                refKey: attachmentRef({ sha256 }), kind: 'attachment', target: sha256, sha256,
                sessionId, messageId, seq: null, origin: 'attachment',
                title: typeof attachment.name === 'string' ? attachment.name.slice(0, 200) : (typeof attachment.mediaType === 'string' ? attachment.mediaType : null),
                bytes: typeof attachment.bytes === 'number' ? attachment.bytes : null,
                meta: refMeta({ mediaType: attachment.mediaType, width: attachment.width, height: attachment.height }),
            });
        }
    }
    return out;
}
function messageText(event, includeReasoning = false) {
    if (event.type !== 'user/message' && event.type !== 'assistant/message')
        return undefined;
    const data = event.data ?? {};
    if (event.type === 'user/message') {
        const source = (data.source ?? {});
        if (source.kind === 'time-context')
            return undefined;
    }
    const message = (data.message ?? {});
    const content = event.type === 'user/message' ? data.content : message.content;
    if (!Array.isArray(content))
        return undefined;
    const blocks = content.filter((block) => typeof block === 'object' && block !== null
        && typeof block.type === 'string'
        && typeof block.text === 'string');
    const text = blocks.filter(block => block.type === 'text').map(block => block.text).join('\n').trim();
    const reasoning = includeReasoning
        ? blocks.filter(block => block.type === 'reasoning' || block.type === 'thinking').map(block => block.text).join('\n').trim()
        : '';
    if (text === '' && reasoning === '')
        return undefined;
    // Final answer first: the 8 KB body cap must not let a long reasoning trace
    // evict the answer itself. Reasoning follows for opt-in search only.
    const body = [text, reasoning].filter(part => part !== '').join('\n');
    const titleText = text !== '' ? text : reasoning;
    const id = event.type === 'user/message' ? String(data.id ?? '') : String(message.id ?? '');
    const safeId = id || `seq-${String(data.seq ?? '')}`;
    let nodeKey = null;
    if (event.type === 'user/message' && id !== '') {
        nodeKey = conversationNodeKey('input-message', id);
    }
    else if (event.type === 'assistant/message') {
        const turn = Number(data.turn);
        const step = Number(data.step);
        if (Number.isInteger(turn) && Number.isInteger(step))
            nodeKey = conversationNodeKey('assistant-step', `${turn}:${step}`);
    }
    return { text: body, titleText, id: safeId, nodeKey };
}
async function sessionFiles(roots) {
    const out = [];
    const walk = async (root, depth) => {
        if (depth > 4)
            return;
        let entries;
        try {
            entries = await readdir(root, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            const path = join(root, entry.name);
            if (entry.isDirectory()) {
                await walk(path, depth + 1);
                continue;
            }
            if (!entry.isFile() || !entry.name.endsWith('.v4.jsonl.zstd'))
                continue;
            try {
                out.push({ path, mtime: (await stat(path)).mtimeMs });
            }
            catch { /* ignore */ }
        }
    };
    for (const root of roots)
        await walk(root, 0);
    out.sort((a, b) => b.mtime - a.mtime);
    return out;
}
function contentSkipPath(path, excludes) {
    const normalized = path.replace(/\\/g, '/');
    // The plugin's own session/config tree is never content.
    if (normalized === '/.dsh' || normalized.includes('/.dsh/'))
        return true;
    if (excludes.length === 0)
        return false;
    const lower = normalized.toLowerCase();
    const segments = lower.split('/');
    for (const raw of excludes) {
        const needle = raw.trim().toLowerCase();
        if (needle === '')
            continue;
        if (needle.includes('/')) {
            if (lower.includes(needle))
                return true;
            continue;
        }
        if (segments.includes(needle))
            return true;
    }
    return false;
}
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
/**
 * Whether a refresh failed only because the engine started a new scan. The
 * engine dump cursor belongs to one snapshot generation, so a rebuild in flight
 * makes the current refresh unanswerable; the database itself is still valid.
 */
function isEngineRescanError(error) {
    return error instanceof Error && error.message.includes('engine re-scan started');
}
//# sourceMappingURL=content.js.map