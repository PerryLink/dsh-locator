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
import type { LocatorRuntime } from './runtime.ts';
export interface ContentHit {
    kind: 'file' | 'session';
    path: string;
    title: string;
    snippet: string;
    sessionId?: string;
    messageId?: string;
    score: number;
}
export interface ContentState {
    building: boolean;
    files: number;
    sessions: number;
    messages: number;
    truncated: boolean;
    error: string;
    updatedAt: number;
}
export interface ContentOptions {
    stateDir: string;
    sessionDirs?: string[] | undefined;
    maxFileBytes: number;
    maxTotalBytes?: number;
    maxFiles: number;
    maxSessions: number;
}
export declare class ContentIndex {
    private readonly rt;
    private readonly options;
    private db;
    private readonly state;
    private generation;
    private totalBytes;
    private timer;
    constructor(rt: LocatorRuntime, options: ContentOptions);
    status(): ContentState;
    /** Start periodic incremental refreshes; 0 disables. */
    startAutoRefresh(ms: number): void;
    /** Queue a full rebuild; false when one is already running. */
    rebuild(): boolean;
    /** Queue an incremental refresh; false when one is already running. */
    refreshNow(): boolean;
    close(): void;
    /** Build everything from scratch. */
    start(): void;
    /** Re-read changed files/sessions; open the DB when this is the first run. */
    refresh(): void;
    private begin;
    private full;
    private incremental;
    private open;
    private finish;
    private addDoc;
    private deleteDoc;
    private deletePath;
    private indexFiles;
    private refreshFiles;
    private readFileDoc;
    private indexSessions;
    private refreshSessions;
    private indexSessionFile;
    sessionRoots(): string[];
    search(query: string, limit: number): ContentHit[];
}
//# sourceMappingURL=content.d.ts.map