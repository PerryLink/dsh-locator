/**
 * Content FTS5 query shared by the host thread and the search worker.
 * @module dsh-locator/content-search
 */
import type { DatabaseSync } from 'node:sqlite';
import type { ContentHit } from './content.ts';
/**
 * Run one content query against an open SQLite handle.
 * @param db - open database (read-only in the worker).
 * @param query - user query; shorter than three characters falls back to LIKE.
 * @param limit - maximum hits.
 * @returns hits, ordered by relevance.
 */
export declare function searchContent(db: DatabaseSync, query: string, limit: number): ContentHit[];
//# sourceMappingURL=content-search.d.ts.map