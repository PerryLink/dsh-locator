/**
 * Content FTS5 query shared by the host thread and the search worker.
 * @module dsh-locator/content-search
 */
/**
 * Run one content query against an open SQLite handle.
 * @param db - open database (read-only in the worker).
 * @param query - user query; shorter than three characters falls back to LIKE.
 * @param limit - maximum hits.
 * @returns hits, ordered by relevance.
 */
export function searchContent(db, query, limit) {
    const text = query.trim();
    if (text === '')
        return [];
    const capped = Math.max(1, Math.min(100, limit));
    let rows;
    if ([...text].length < 3) {
        // A one- or two-character query cannot use the trigram index, so bound the
        // payload as well as the row count: never ship a whole megabyte body.
        rows = db.prepare(`SELECT kind, path, title, session_id, message_id,
      (SELECT node_key FROM docs_meta WHERE docs_meta.rowid = docs.rowid) AS node_key,
      substr(body, 1, 400) AS snippet, 0 AS score
      FROM docs WHERE body LIKE '%' || ? || '%' LIMIT ?`).all(text, capped);
    }
    else {
        const match = text.split(/\s+/).filter(Boolean).map(term => '"' + term.replace(/"/g, '') + '"').join(' AND ');
        // Keep MATCH in this statement: FTS5 snippet() and bm25() are only defined
        // inside a matching query (a rowid subquery silently degrades both). The
        // query runs in the search worker, so its cost stays off the host thread.
        rows = db.prepare(`SELECT kind, path, title, session_id, message_id,
      (SELECT node_key FROM docs_meta WHERE docs_meta.rowid = docs.rowid) AS node_key,
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
        ...(row.node_key ? { nodeKey: String(row.node_key) } : {}),
        score: Number(row.score ?? 0),
    }));
}
//# sourceMappingURL=content-search.js.map