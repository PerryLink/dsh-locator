/**
 * Content search: text files and DSH session messages in SQLite FTS5.
 *
 * The file-name index stays in the Go engine. This store is built beside it:
 * the engine's `dump` RPC supplies the already-scanned file list, Node reads
 * text files and decompresses `session.v4.jsonl.zstd` logs, and SQLite's
 * trigram tokenizer gives substring/CJK search with snippets.
 * @module dsh-locator/content
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
const TEXT_EXTENSIONS = new Set([
    '.txt', '.md', '.markdown', '.rst', '.log', '.csv', '.tsv', '.json', '.jsonl',
    '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.xml', '.html', '.htm',
    '.css', '.scss', '.less', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
    '.go', '.rs', '.py', '.rb', '.php', '.java', '.kt', '.swift', '.c', '.h',
    '.cc', '.cpp', '.hpp', '.cs', '.sh', '.bash', '.zsh', '.fish', '.ps1',
    '.sql', '.graphql', '.proto', '.tex', '.org', '.adoc',
]);
/** The content store; one instance per plugin. */
export class ContentIndex {
    rt;
    options;
    db = null;
    state = { building: false, files: 0, sessions: 0, messages: 0, truncated: false, error: '', updatedAt: 0 };
    generation = 0;
    constructor(rt, options) {
        this.rt = rt;
        this.options = options;
    }
    status() { return { ...this.state }; }
    /** Close the database when the plugin unmounts. */
    close() {
        this.generation++;
        this.db?.close();
        this.db = null;
        this.state.building = false;
    }
    /** Build in the background; stale generations stop at their next checkpoint. */
    start() {
        const generation = ++this.generation;
        this.state.building = true;
        this.state.truncated = false;
        this.state.error = '';
        void this.build(generation).catch(error => {
            if (generation !== this.generation)
                return;
            this.state.error = messageOf(error);
            this.state.building = false;
        });
    }
    async build(generation) {
        const { DatabaseSync } = await import('node:sqlite');
        const path = join(this.options.stateDir, 'content.db');
        mkdirSync(this.options.stateDir, { recursive: true });
        this.db?.close();
        this.db = new DatabaseSync(path);
        this.db.exec('PRAGMA journal_mode = WAL');
        this.db.exec('PRAGMA synchronous = OFF');
        this.db.exec('DROP TABLE IF EXISTS docs');
        this.db.exec(`CREATE VIRTUAL TABLE docs USING fts5(
      body,
      kind UNINDEXED,
      path UNINDEXED,
      title UNINDEXED,
      session_id UNINDEXED,
      message_id UNINDEXED,
      tokenize = 'trigram'
    )`);
        const insert = this.db.prepare('INSERT INTO docs (body, kind, path, title, session_id, message_id) VALUES (?, ?, ?, ?, ?, ?)');
        const flush = (rows) => {
            if (rows.length === 0)
                return;
            this.db.exec('BEGIN');
            try {
                for (const row of rows)
                    insert.run(...row);
                this.db.exec('COMMIT');
            }
            catch (error) {
                this.db.exec('ROLLBACK');
                throw error;
            }
        };
        this.state.truncated = false;
        await this.indexSessions(flush, generation);
        if (generation !== this.generation)
            return;
        await this.indexFiles(flush, generation);
        if (generation !== this.generation)
            return;
        this.state.building = false;
        this.state.updatedAt = Date.now();
    }
    totalBytes = 0;
    /** Account one body against the total cap; false means the cap was reached. */
    account(body) {
        const cap = this.options.maxTotalBytes ?? 0;
        if (cap > 0 && this.totalBytes + body.length > cap) {
            this.state.truncated = true;
            return false;
        }
        this.totalBytes += body.length;
        return true;
    }
    async indexSessions(flush, generation) {
        const files = [];
        for (const root of this.sessionRoots()) {
            walkSessions(root, files, 0);
        }
        files.sort((a, b) => b.mtime - a.mtime);
        const limit = this.options.maxSessions > 0 ? this.options.maxSessions : files.length;
        let batch = [];
        for (const file of files.slice(0, limit)) {
            if (generation !== this.generation)
                return;
            let text;
            try {
                text = zstdDecompressSync(readFileSync(file.path)).toString('utf8');
            }
            catch {
                continue;
            }
            const sessionId = basename(dirname(file.path));
            let title = '';
            let messages = 0;
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
                if (!this.account(body))
                    break;
                batch.push([body, 'session', file.path, title || sessionId, sessionId, extracted.id]);
                messages++;
                if (batch.length >= 200) {
                    flush(batch);
                    batch = [];
                }
            }
            if (this.state.truncated) {
                flush(batch);
                return;
            }
            this.state.sessions++;
            this.state.messages += messages;
        }
        flush(batch);
    }
    async indexFiles(flush, generation) {
        let after = 0;
        let batch = [];
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
                let raw;
                try {
                    raw = readFileSync(entry.path, 'utf8');
                }
                catch {
                    continue;
                }
                if (raw.includes('\u0000'))
                    continue;
                const body = raw.slice(0, this.options.maxFileBytes);
                if (!this.account(body)) {
                    flush(batch);
                    return;
                }
                seen++;
                this.state.files++;
                batch.push([body, 'file', entry.path, entry.name, null, null]);
                if (batch.length >= 200) {
                    flush(batch);
                    batch = [];
                }
            }
            after = page.next;
            if (page.done || page.entries.length === 0)
                break;
        }
        flush(batch);
    }
    sessionRoots() {
        if (this.options.sessionDirs.length > 0)
            return this.options.sessionDirs;
        const home = process.env.DSH_HOME || join(homedir(), '.dsh');
        return [join(home, 'sessions')];
    }
    /** Query the FTS table; short queries fall back to LIKE because trigram needs 3 chars. */
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
    const id = event.type === 'user/message'
        ? String(data.id ?? '')
        : String(message.id ?? '');
    return { text, id: id || `seq-${String(data.seq ?? '')}` };
}
function walkSessions(root, out, depth) {
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
            walkSessions(path, out, depth + 1);
            continue;
        }
        if (!entry.isFile() || !entry.name.endsWith('.v4.jsonl.zstd'))
            continue;
        try {
            out.push({ path, mtime: statSync(path).mtimeMs });
        }
        catch { /* ignore */ }
    }
}
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=content.js.map