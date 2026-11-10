/**
 * Content search: text files and DSH session messages in SQLite FTS5.
 *
 * The file-name index stays in the Go engine. This store is built beside it:
 * the engine's `dump` RPC supplies the already-scanned file list, Node reads
 * text files and decompresses `session.v4.jsonl.zstd` logs, and SQLite's
 * trigram tokenizer gives substring/CJK search with snippets.
 * @module dsh-locator/content
 */
import type { LocatorRuntime } from './runtime.ts';
/** One searchable document. */
export interface ContentHit {
    kind: 'file' | 'session';
    path: string;
    title: string;
    snippet: string;
    sessionId?: string;
    messageId?: string;
    score: number;
}
/** Build progress shown by the panel/status. */
export interface ContentState {
    building: boolean;
    files: number;
    sessions: number;
    messages: number;
    truncated: boolean;
    error: string;
    updatedAt: number;
}
/** The content store; one instance per plugin. */
export declare class ContentIndex {
    private readonly rt;
    private readonly options;
    private db;
    private readonly state;
    private generation;
    constructor(rt: LocatorRuntime, options: {
        stateDir: string;
        sessionDirs: string[];
        maxFileBytes: number;
        maxTotalBytes?: number;
        maxFiles: number;
        maxSessions: number;
    });
    status(): ContentState;
    /** Close the database when the plugin unmounts. */
    close(): void;
    /** Build in the background; stale generations stop at their next checkpoint. */
    start(): void;
    private build;
    private totalBytes;
    /** Account one body against the total cap; false means the cap was reached. */
    private account;
    private indexSessions;
    private indexFiles;
    private sessionRoots;
    /** Query the FTS table; short queries fall back to LIKE because trigram needs 3 chars. */
    search(query: string, limit: number): ContentHit[];
}
//# sourceMappingURL=content.d.ts.map