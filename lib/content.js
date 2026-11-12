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
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { promisify } from 'node:util';
import { zstdDecompress } from 'node:zlib';
import { scheduler } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { searchContent } from "./content-search.js";
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
export class ContentIndex {
    rt;
    options;
    db = null;
    state = { building: false, files: 0, sessions: 0, messages: 0, truncated: false, error: '', updatedAt: 0 };
    generation = 0;
    totalBytes = 0;
    sliceDeadline = 0;
    worker = null;
    lockHeld = false;
    lockToken = randomUUID();
    workerSeq = 0;
    pendingStart = false;
    dbIdentity = null;
    /** Session id → indexed session log path, for session-scoped content search. */
    sessionPaths = new Map();
    pending = new Map();
    constructor(rt, options) {
        this.rt = rt;
        this.options = options;
    }
    status() {
        if (this.db !== null && !this.state.building && !this.databaseIsCurrent())
            this.recoverExternal();
        return { ...this.state, building: this.state.building || this.pendingStart };
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
        this.dbIdentity = null;
        this.sessionPaths.clear();
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
        const run = mode === 'full' ? this.full(generation) : this.incremental(generation);
        void run.catch(error => {
            if (generation !== this.generation)
                return;
            this.state.error = messageOf(error);
            this.state.building = false;
        }).finally(() => {
            this.releaseLock();
        });
    }
    async full(generation) {
        this.open(true);
        this.totalBytes = 0;
        await this.indexSessions(generation);
        if (generation !== this.generation)
            return;
        await this.indexFiles(generation);
        if (generation !== this.generation)
            return;
        this.finish();
    }
    async incremental(generation) {
        try {
            this.open(false);
            const stored = this.db.prepare('PRAGMA user_version').get()?.user_version ?? 0;
            if (Number(stored) !== SCHEMA_VERSION)
                return await this.full(generation);
            // A database whose last build never finished (crash, update, forced
            // reload) has a stale byte counter; rebuild instead of trusting it.
            if (this.readFlag('complete') !== 1)
                return await this.full(generation);
            this.totalBytes = this.readTotalBytes();
            await this.refreshFiles(generation);
            if (generation !== this.generation)
                return;
            await this.refreshSessions(generation);
            if (generation !== this.generation)
                return;
            this.finish();
        }
        catch {
            if (generation !== this.generation)
                return;
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
        if (existed && !this.ownedDatabase(dbPath)) {
            throw new Error(`content.db is not a dsh-locator database, refusing to touch it: ${dbPath}`);
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
        }
        this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(
      body, kind UNINDEXED, path UNINDEXED, title UNINDEXED,
      session_id UNINDEXED, message_id UNINDEXED, tokenize = 'trigram'
    )`);
        this.db.exec('CREATE TABLE IF NOT EXISTS docs_meta (rowid INTEGER PRIMARY KEY, doc_key TEXT UNIQUE, path TEXT, mtime INTEGER, kind TEXT, node_key TEXT)');
        this.db.exec('CREATE TABLE IF NOT EXISTS sources (path TEXT PRIMARY KEY, mtime INTEGER)');
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
    reopenWorker() {
        if (this.worker === null)
            return;
        this.worker.postMessage({ id: ++this.workerSeq, open: join(this.options.stateDir, 'content.db') });
    }
    stopWorker() {
        const worker = this.worker;
        this.worker = null;
        for (const entry of this.pending.values())
            entry.resolve(emptySearchResult());
        this.pending.clear();
        if (worker !== null)
            void worker.terminate();
    }
    ensureWorker() {
        if (this.options.searchWorker !== true || this.worker !== null)
            return;
        // In a TypeScript test run the compiled worker does not exist next to the
        // source; skip spawning and answer queries in-process instead.
        const workerPath = fileURLToPath(new URL('./content-search-worker.js', import.meta.url));
        if (!existsSync(workerPath))
            return;
        try {
            const worker = new Worker(workerPath, {
                workerData: { dbPath: join(this.options.stateDir, 'content.db') },
            });
            worker.on('message', (message) => {
                const entry = this.pending.get(message.id);
                if (entry === undefined)
                    return;
                this.pending.delete(message.id);
                if (typeof message.error === 'string' && message.error !== '') {
                    entry.reject(new Error(message.error));
                    return;
                }
                entry.resolve(message.result ?? emptySearchResult());
            });
            const fail = () => {
                if (this.worker !== worker)
                    return;
                this.worker = null;
                for (const entry of this.pending.values())
                    entry.reject(new Error('content search worker failed'));
                this.pending.clear();
            };
            worker.on('error', fail);
            worker.on('exit', fail);
            this.worker = worker;
        }
        catch {
            this.worker = null;
        }
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
        this.state.updatedAt = 0;
        this.state.error = '';
        this.state.truncated = false;
        this.state.files = 0;
        this.state.sessions = 0;
        this.state.messages = 0;
        this.boot();
    }
    /** Whether the engine is re-scanning, which can move its dump cursor. */
    engineRescanning() {
        const scanning = this.rt.status?.scanning;
        return scanning !== undefined && scanning !== null;
    }
    /** Whether `path` is a SQLite database this plugin created (has docs_meta). */
    ownedDatabase(path) {
        let probe;
        try {
            probe = new DatabaseSync(path, { readOnly: true });
            const row = probe.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'docs_meta'").get();
            return row !== undefined;
        }
        catch {
            return false;
        }
        finally {
            try {
                probe?.close();
            }
            catch { /* ignore */ }
        }
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
    finish() {
        const counts = this.db.prepare("SELECT kind, COUNT(*) AS n FROM docs_meta GROUP BY kind").all();
        this.state.files = Number(counts.find(row => row.kind === 'file')?.n ?? 0);
        this.state.messages = Number(counts.find(row => row.kind === 'session')?.n ?? 0);
        this.state.sessions = Number(this.db.prepare('SELECT COUNT(*) AS n FROM sources').get().n);
        this.state.building = false;
        this.state.updatedAt = Date.now();
        this.writeTotalBytes();
        this.writeFlag('complete', 1);
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
            const rows = this.db.prepare('SELECT path FROM sources').all();
            for (const row of rows) {
                const path = row.path;
                if (typeof path !== 'string' || path === '')
                    continue;
                const sessionId = basename(dirname(path));
                if (sessionId !== '')
                    this.sessionPaths.set(sessionId, path);
            }
        }
        catch {
            // A database from an older schema cannot answer session-scoped queries
            // until its next rebuild; leave the map empty instead of failing boot.
        }
    }
    addDoc(row) {
        const cap = this.options.maxTotalBytes ?? 0;
        if (cap > 0 && this.totalBytes + row.body.length > cap) {
            this.state.truncated = true;
            return false;
        }
        this.deleteDoc(row.key);
        const meta = this.db.prepare('INSERT INTO docs_meta (doc_key, path, mtime, kind, node_key) VALUES (?, ?, ?, ?, ?)').run(row.key, row.path, row.mtime, row.kind, row.nodeKey);
        const rowid = meta.lastInsertRowid;
        this.db.prepare('INSERT INTO docs (rowid, body, kind, path, title, session_id, message_id) VALUES (?, ?, ?, ?, ?, ?, ?)').run(rowid, row.body, row.kind, row.path, row.title, row.sessionId, row.messageId);
        this.totalBytes += row.body.length;
        return true;
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
                if (entry.dir || entry.size <= 0 || entry.size > this.options.maxFileBytes)
                    continue;
                if (!TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase()) || contentSkipPath(entry.path, this.options.excludes ?? []))
                    continue;
                if (this.options.maxFiles > 0 && seen >= this.options.maxFiles)
                    break;
                const row = await this.readFileDoc(entry.path, entry.name, entry.mtime);
                if (row === null)
                    continue;
                seen++;
                if (!this.addDoc(row))
                    return;
                await this.breathe();
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
        let indexed = 0;
        let scanned = 0;
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
                if (entry.dir || entry.size <= 0 || entry.size > this.options.maxFileBytes)
                    continue;
                if (!TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase()) || contentSkipPath(entry.path, this.options.excludes ?? []))
                    continue;
                if (this.options.maxFiles > 0 && indexed >= this.options.maxFiles)
                    break;
                const key = `file:${entry.path}`;
                seen.add(key);
                indexed++;
                if (meta.get(key) === entry.mtime)
                    continue;
                if (this.wouldExceed(entry.size)) {
                    deferred.push({ path: entry.path, name: entry.name, mtime: entry.mtime, size: entry.size });
                    continue;
                }
                this.deleteDoc(key);
                const row = await this.readFileDoc(entry.path, entry.name, entry.mtime);
                if (row !== null && !this.addDoc(row)) {
                    deferred.push({ path: entry.path, name: entry.name, mtime: entry.mtime, size: entry.size });
                }
                await this.breathe();
            }
            after = page.next;
            if (page.done || page.entries.length === 0)
                break;
        }
        // Removing rows for files that disappeared frees budget before the deferred
        // files are retried; otherwise a stale large entry would block new ones.
        for (const key of meta.keys())
            if (!seen.has(key))
                this.deleteDoc(key);
        for (const entry of deferred) {
            if (generation !== this.generation)
                return;
            if (this.wouldExceed(entry.size)) {
                this.state.truncated = true;
                continue;
            }
            this.deleteDoc(`file:${entry.path}`);
            const row = await this.readFileDoc(entry.path, entry.name, entry.mtime);
            if (row === null || !this.addDoc(row)) {
                this.state.truncated = true;
                continue;
            }
            await this.breathe();
        }
    }
    /** Would storing a file of this size overflow the configured body budget? */
    wouldExceed(size) {
        const cap = this.options.maxTotalBytes ?? 0;
        if (cap <= 0)
            return false;
        return this.totalBytes + Math.min(size, this.options.maxFileBytes) > cap;
    }
    async readFileDoc(path, name, mtime) {
        let buffer;
        try {
            buffer = await readFile(path);
        }
        catch {
            return null;
        }
        if (buffer.includes(0))
            return null;
        const body = buffer.toString('utf8').slice(0, this.options.maxFileBytes);
        return { key: `file:${path}`, body, kind: 'file', path, title: name, sessionId: null, messageId: null, nodeKey: null, mtime };
    }
    async indexSessions(generation) {
        const files = (await this.sessionCandidates()).filter(file => this.settled(file.mtime));
        for (const file of files) {
            if (generation !== this.generation)
                return;
            this.deletePath(file.path);
            if (!(await this.indexSessionFile(file, generation)))
                return;
            this.db.prepare('INSERT OR REPLACE INTO sources (path, mtime) VALUES (?, ?)').run(file.path, file.mtime);
            await this.breathe();
        }
    }
    async refreshSessions(generation) {
        const known = new Map();
        for (const row of this.db.prepare('SELECT path, mtime FROM sources').all())
            known.set(row.path, row.mtime);
        const files = await this.sessionCandidates();
        const present = new Set();
        for (const file of files) {
            if (generation !== this.generation)
                return;
            present.add(file.path);
            // The session being written right now is left for a later refresh: keep
            // its existing rows instead of re-reading the whole growing log.
            if (!this.settled(file.mtime))
                continue;
            if (known.get(file.path) === file.mtime)
                continue;
            this.deletePath(file.path);
            if (!(await this.indexSessionFile(file, generation)))
                return;
            this.db.prepare('INSERT OR REPLACE INTO sources (path, mtime) VALUES (?, ?)').run(file.path, file.mtime);
            await this.breathe();
        }
        for (const path of known.keys()) {
            if (present.has(path))
                continue;
            this.deletePath(path);
            this.db.prepare('DELETE FROM sources WHERE path = ?').run(path);
        }
    }
    async indexSessionFile(file, generation) {
        let text;
        try {
            text = (await zstdDecompressAsync(await readFile(file.path))).toString('utf8');
        }
        catch {
            return true;
        }
        if (generation !== this.generation)
            return false;
        const sessionId = basename(dirname(file.path));
        this.sessionPaths.set(sessionId, file.path);
        let title = '';
        let parsed = 0;
        for (const line of text.split('\n')) {
            if (!line)
                continue;
            if ((++parsed & 0xff) === 0) {
                await this.breathe();
                if (generation !== this.generation)
                    return false;
            }
            let event;
            try {
                event = JSON.parse(line);
            }
            catch {
                continue;
            }
            const extracted = messageText(event);
            if (extracted === undefined)
                continue;
            if (title === '')
                title = extracted.text.replace(/\s+/g, ' ').slice(0, 90);
            const body = extracted.text.slice(0, SESSION_BODY_BYTES);
            const row = { key: `session:${sessionId}:${extracted.id}`, body, kind: 'session', path: file.path, title: title || sessionId, sessionId, messageId: extracted.id, nodeKey: extracted.nodeKey, mtime: file.mtime };
            if (!this.addDoc(row))
                return false;
        }
        return true;
    }
    /** Session logs to consider, newest first, minus archived ones by default. */
    async sessionCandidates() {
        const files = await sessionFiles(this.sessionRoots());
        const archived = this.options.includeArchived === true ? new Set() : await archivedSessionIds();
        const max = this.options.maxSessions > 0 ? this.options.maxSessions : Number.POSITIVE_INFINITY;
        const out = [];
        for (const file of files) {
            if (out.length >= max)
                break;
            if (archived.has(basename(dirname(file.path))))
                continue;
            out.push(file);
        }
        return out;
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
        const resolved = this.resolveSession(options);
        if (resolved === null)
            return emptySearchResult(['unknown-session']);
        if (this.db === null)
            return emptySearchResult();
        if (!this.databaseIsCurrent()) {
            this.recoverExternal();
            return emptySearchResult();
        }
        if (this.options.searchWorker !== true)
            return this.searchSync(query, limit, resolved);
        this.ensureWorker();
        if (this.worker === null)
            return this.searchSync(query, limit, resolved);
        const id = ++this.workerSeq;
        const worker = this.worker;
        const response = new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); });
        worker.postMessage({ id, query, limit, options: resolved });
        let timer;
        const timeout = new Promise((_resolve, reject) => {
            timer = setTimeout(() => { this.pending.delete(id); reject(new Error('content search worker timed out')); }, 5_000);
        });
        try {
            return await Promise.race([response, timeout]);
        }
        catch {
            return this.searchSync(query, limit, resolved);
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
    searchSync(query, limit, options) {
        if (this.db === null)
            return emptySearchResult();
        try {
            return searchContent(this.db, query, limit, options);
        }
        catch (error) {
            this.state.error = messageOf(error);
            return emptySearchResult();
        }
    }
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
function messageText(event) {
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
    const text = content
        .filter((block) => typeof block === 'object' && block !== null && block.type === 'text' && typeof block.text === 'string')
        .map(block => block.text)
        .join('\n')
        .trim();
    if (text === '')
        return undefined;
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
    return { text, id: safeId, nodeKey };
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
//# sourceMappingURL=content.js.map