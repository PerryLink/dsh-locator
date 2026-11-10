/**
 * Content search: text files and DSH session messages in SQLite FTS5.
 *
 * File names stay in the Go engine. This store is built from the engine's
 * `dump` RPC plus the session logs: Node reads text bodies, decompresses
 * `session.v4.jsonl.zstd`, and SQLite's trigram tokenizer gives substring and
 * CJK search. A meta table stores each source's mtime so refresh() only
 * re-reads what changed; rebuild() drops and rebuilds everything.
 * @module dsh-locator/content
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
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
    timer;
    constructor(rt, options) {
        this.rt = rt;
        this.options = options;
    }
    status() { return { ...this.state }; }
    /** Start periodic incremental refreshes; 0 disables. */
    startAutoRefresh(ms) {
        if (ms <= 0 || this.timer !== undefined)
            return;
        this.timer = setInterval(() => this.refresh(), ms);
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
        if (this.timer !== undefined) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
        this.generation++;
        this.db?.close();
        this.db = null;
        this.state.building = false;
    }
    /** Build everything from scratch. */
    start() { this.begin('full'); }
    /** Re-read changed files/sessions; open the DB when this is the first run. */
    refresh() { this.begin(this.db === null ? 'full' : 'incremental'); }
    begin(mode) {
        if (this.state.building)
            return;
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
        });
    }
    async full(generation) {
        this.open(true);
        this.totalBytes = 0;
        await this.indexFiles(generation);
        if (generation !== this.generation)
            return;
        await this.indexSessions(generation);
        if (generation !== this.generation)
            return;
        this.finish();
    }
    async incremental(generation) {
        this.open(false);
        this.totalBytes = Number(this.db.prepare('SELECT COALESCE(SUM(length(body)), 0) AS n FROM docs').get().n);
        await this.refreshFiles(generation);
        if (generation !== this.generation)
            return;
        await this.refreshSessions(generation);
        if (generation !== this.generation)
            return;
        this.finish();
    }
    open(fresh) {
        mkdirSync(this.options.stateDir, { recursive: true });
        this.db?.close();
        this.db = new DatabaseSync(join(this.options.stateDir, 'content.db'));
        this.db.exec('PRAGMA journal_mode = WAL');
        this.db.exec('PRAGMA synchronous = OFF');
        if (fresh) {
            this.db.exec('DROP TABLE IF EXISTS docs');
            this.db.exec('DROP TABLE IF EXISTS docs_meta');
            this.db.exec('DROP TABLE IF EXISTS sources');
        }
        this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(
      body, kind UNINDEXED, path UNINDEXED, title UNINDEXED,
      session_id UNINDEXED, message_id UNINDEXED, tokenize = 'trigram'
    )`);
        this.db.exec('CREATE TABLE IF NOT EXISTS docs_meta (rowid INTEGER PRIMARY KEY, doc_key TEXT UNIQUE, path TEXT, mtime INTEGER, kind TEXT)');
        this.db.exec('CREATE TABLE IF NOT EXISTS sources (path TEXT PRIMARY KEY, mtime INTEGER)');
    }
    finish() {
        const counts = this.db.prepare("SELECT kind, COUNT(*) AS n FROM docs_meta GROUP BY kind").all();
        this.state.files = Number(counts.find(row => row.kind === 'file')?.n ?? 0);
        this.state.messages = Number(counts.find(row => row.kind === 'session')?.n ?? 0);
        this.state.sessions = Number(this.db.prepare('SELECT COUNT(*) AS n FROM sources').get().n);
        this.state.building = false;
        this.state.updatedAt = Date.now();
    }
    addDoc(row) {
        const cap = this.options.maxTotalBytes ?? 0;
        if (cap > 0 && this.totalBytes + row.body.length > cap) {
            this.state.truncated = true;
            return false;
        }
        this.deleteDoc(row.key);
        const meta = this.db.prepare('INSERT INTO docs_meta (doc_key, path, mtime, kind) VALUES (?, ?, ?, ?)').run(row.key, row.path, row.mtime, row.kind);
        const rowid = meta.lastInsertRowid;
        this.db.prepare('INSERT INTO docs (rowid, body, kind, path, title, session_id, message_id) VALUES (?, ?, ?, ?, ?, ?, ?)').run(rowid, row.body, row.kind, row.path, row.title, row.sessionId, row.messageId);
        this.totalBytes += row.body.length;
        return true;
    }
    deleteDoc(key) {
        const row = this.db.prepare('SELECT rowid FROM docs_meta WHERE doc_key = ?').get(key);
        if (row === undefined)
            return;
        this.db.prepare('DELETE FROM docs WHERE rowid = ?').run(row.rowid);
        this.db.prepare('DELETE FROM docs_meta WHERE rowid = ?').run(row.rowid);
    }
    deletePath(path) {
        const rows = this.db.prepare('SELECT rowid FROM docs_meta WHERE path = ?').all(path);
        const delDoc = this.db.prepare('DELETE FROM docs WHERE rowid = ?');
        const delMeta = this.db.prepare('DELETE FROM docs_meta WHERE rowid = ?');
        for (const row of rows) {
            delDoc.run(row.rowid);
            delMeta.run(row.rowid);
        }
    }
    async indexFiles(generation) {
        let after = 0;
        let seen = 0;
        for (;;) {
            if (generation !== this.generation)
                return;
            const page = await this.rt.dump(after, 2_000);
            for (const entry of page.entries) {
                if (entry.dir || entry.size <= 0 || entry.size > this.options.maxFileBytes)
                    continue;
                if (!TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase()))
                    continue;
                if (this.options.maxFiles > 0 && seen >= this.options.maxFiles)
                    break;
                const row = this.readFileDoc(entry.path, entry.name, entry.mtime);
                if (row === null)
                    continue;
                seen++;
                if (!this.addDoc(row))
                    return;
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
        let after = 0;
        let indexed = 0;
        for (;;) {
            if (generation !== this.generation)
                return;
            const page = await this.rt.dump(after, 2_000);
            for (const entry of page.entries) {
                if (entry.dir || entry.size <= 0 || entry.size > this.options.maxFileBytes)
                    continue;
                if (!TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase()))
                    continue;
                if (this.options.maxFiles > 0 && indexed >= this.options.maxFiles)
                    break;
                const key = `file:${entry.path}`;
                seen.add(key);
                indexed++;
                if (meta.get(key) === entry.mtime)
                    continue;
                this.deleteDoc(key);
                const row = this.readFileDoc(entry.path, entry.name, entry.mtime);
                if (row !== null && !this.addDoc(row))
                    return;
            }
            after = page.next;
            if (page.done || page.entries.length === 0)
                break;
        }
        for (const key of meta.keys())
            if (!seen.has(key))
                this.deleteDoc(key);
    }
    readFileDoc(path, name, mtime) {
        let raw;
        try {
            raw = readFileSync(path, 'utf8');
        }
        catch {
            return null;
        }
        if (raw.includes('\u0000'))
            return null;
        return { key: `file:${path}`, body: raw.slice(0, this.options.maxFileBytes), kind: 'file', path, title: name, sessionId: null, messageId: null, mtime };
    }
    async indexSessions(generation) {
        const files = sessionFiles(this.sessionRoots()).slice(0, this.options.maxSessions > 0 ? this.options.maxSessions : undefined);
        for (const file of files) {
            if (generation !== this.generation)
                return;
            this.deletePath(file.path);
            if (!this.indexSessionFile(file))
                return;
            this.db.prepare('INSERT OR REPLACE INTO sources (path, mtime) VALUES (?, ?)').run(file.path, file.mtime);
        }
    }
    async refreshSessions(generation) {
        const known = new Map();
        for (const row of this.db.prepare('SELECT path, mtime FROM sources').all())
            known.set(row.path, row.mtime);
        const files = sessionFiles(this.sessionRoots()).slice(0, this.options.maxSessions > 0 ? this.options.maxSessions : undefined);
        const present = new Set();
        for (const file of files) {
            if (generation !== this.generation)
                return;
            present.add(file.path);
            if (known.get(file.path) === file.mtime)
                continue;
            this.deletePath(file.path);
            if (!this.indexSessionFile(file))
                return;
            this.db.prepare('INSERT OR REPLACE INTO sources (path, mtime) VALUES (?, ?)').run(file.path, file.mtime);
        }
        for (const path of known.keys()) {
            if (present.has(path))
                continue;
            this.deletePath(path);
            this.db.prepare('DELETE FROM sources WHERE path = ?').run(path);
        }
    }
    indexSessionFile(file) {
        let text;
        try {
            text = zstdDecompressSync(readFileSync(file.path)).toString('utf8');
        }
        catch {
            return true;
        }
        const sessionId = basename(dirname(file.path));
        let title = '';
        for (const line of text.split('\n')) {
            if (!line)
                continue;
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
            const body = extracted.text.slice(0, 8_000);
            const row = { key: `session:${sessionId}:${extracted.id}`, body, kind: 'session', path: file.path, title: title || sessionId, sessionId, messageId: extracted.id, mtime: file.mtime };
            if (!this.addDoc(row))
                return false;
        }
        return true;
    }
    sessionRoots() {
        if (this.options.sessionDirs !== undefined)
            return this.options.sessionDirs;
        return [join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'sessions')];
    }
    search(query, limit) {
        if (this.db === null)
            return [];
        const text = query.trim();
        if (text === '')
            return [];
        const capped = Math.max(1, Math.min(100, limit));
        try {
            let rows;
            if ([...text].length < 3) {
                rows = this.db.prepare(`SELECT kind, path, title, session_id, message_id, body, 0 AS score
          FROM docs WHERE body LIKE '%' || ? || '%' LIMIT ?`).all(text, capped);
            }
            else {
                const match = text.split(/\s+/).filter(Boolean).map(term => '"' + term.replace(/"/g, '') + '"').join(' AND ');
                rows = this.db.prepare(`SELECT kind, path, title, session_id, message_id,
          snippet(docs, 0, char(1), char(2), '…', 16) AS snippet, bm25(docs) AS score
          FROM docs WHERE docs MATCH ? ORDER BY score LIMIT ?`).all(match, capped);
            }
            return rows.map(row => ({
                kind: row.kind === 'session' ? 'session' : 'file',
                path: String(row.path ?? ''),
                title: String(row.title ?? ''),
                snippet: String(row.snippet ?? row.body ?? '').replace(/[\u0001\u0002]/g, ''),
                ...(row.session_id ? { sessionId: String(row.session_id) } : {}),
                ...(row.message_id ? { messageId: String(row.message_id) } : {}),
                score: Number(row.score ?? 0),
            }));
        }
        catch (error) {
            this.state.error = messageOf(error);
            return [];
        }
    }
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
    return { text, id: id || `seq-${String(data.seq ?? '')}` };
}
function sessionFiles(roots) {
    const out = [];
    const walk = (root, depth) => {
        if (depth > 4 || !existsSync(root))
            return;
        let entries;
        try {
            entries = readdirSync(root, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            const path = join(root, entry.name);
            if (entry.isDirectory()) {
                walk(path, depth + 1);
                continue;
            }
            if (!entry.isFile() || !entry.name.endsWith('.v4.jsonl.zstd'))
                continue;
            try {
                out.push({ path, mtime: statSync(path).mtimeMs });
            }
            catch { /* ignore */ }
        }
    };
    for (const root of roots)
        walk(root, 0);
    out.sort((a, b) => b.mtime - a.mtime);
    return out;
}
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=content.js.map