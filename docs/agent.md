# Agent guide — the 2026-11 tool contract

Applies to `dsh-locator` **0.23.0**. This page is for the agents and integrations that call the tools; installation is in [install.md](install.md) and configuration in [config.md](config.md).

## Default surface: 3 + 1

The host registers four locator tools. Three are resident (part of the initial agent prompt); `locator_admin` is deferred and loaded only when an agent asks for it by name:

| Tool | Resident | Purpose |
|---|---|---|
| `locator_find` | yes | The single search entry point: names, body text, DSH session messages and code symbols, with one envelope. |
| `locator_read` | yes | Read a ref / `refs[]` / an absolute path as `meta`, `excerpt` or `quote`. |
| `locator_status` | yes | Index/content/scope status; brief by default. |
| `locator_admin` | deferred | Maintenance: `rebuild`, `reindex`, `export`. |

The pre-0.22 tools are **not registered by default** in 0.23.0. Set `legacyTools: true` in the profile to register `locator_search`, `locator_rebuild`, `locator_reindex`, `locator_export`, `locator_resolve`, `locator_cite`, `locator_explore`, `locator_outline`, `locator_symbol` and `locator_repo_map` again (deferred). The two capability-adapter tools (`capability_search`, `capability_preflight`) stay registered: they discover DSH capabilities, not files.

### Capability adapters (0.23 fixes)

`capability_search` and `capability_preflight` are unchanged in purpose but fixed in classification: risk keywords are matched against the **tool name only** (a description that mentions `cat`/`rename` no longer marks a tool as exec or write), explicit overrides classify `locator_read` as read-only and `locator_admin` as write + approval, and the resident locator tools rank ahead of legacy tools when both match an intent. `capability_preflight` returns the effective `risk{level,actions,basis}` and `permission` block.

## The envelope

Every 2026-11 answer is one JSON object with a fixed shell. Success:

```json
{
  "apiVersion": "2026-11",
  "ok": true,
  "tool": "locator_find",
  "query": "retry policy",
  "mode": "auto",
  "resolvedMode": "mixed",
  "detail": "compact",
  "scope": { "requested": "workspace", "effective": "workspace", "fallback": false },
  "items": [ /* rows */ ],
  "page": { "limit": 10, "returned": 10, "more": true, "nextCursor": "<opaque>" },
  "counts": { "total": 42, "totalKind": "bounded" },
  "coverage": { "indexing": false, "indexTruncated": false, "notes": [] },
  "budget": { "limitChars": 8000, "usedChars": 4321, "truncated": false, "dropped": 0 },
  "timing": { "tookMs": 18 }
}
```

Failure (the same shape; `ok:false`):

```json
{
  "apiVersion": "2026-11",
  "ok": false,
  "tool": "locator_find",
  "error": {
    "code": "cursor-invalid",
    "message": "cursor does not belong to this query, mode or scope",
    "retryable": false,
    "remediation": "Re-run the query without a cursor: cursors are bound to the query, mode and scope.",
    "nextTools": ["locator_find"]
  },
  "timing": { "tookMs": 2 }
}
```

`apiVersion` bumps only on a breaking change. Clients should key on `ok` first, then `error.code`; never parse `error.message`.

## `locator_find`

One search entry point for four surfaces: file names/paths, file bodies, DSH session messages and code symbols.

### Parameters

| Parameter | Default | Notes |
|---|---|---|
| `query` | — (required) | Words/phrase, name fragment or identifier. Empty is rejected with `invalid-argument`. |
| `mode` | `auto` | `auto` merges the sources its `kinds` allow; `name`, `body`, `symbol` pin one source. |
| `kinds` | all | `file`, `dir`, `session`, `symbol`. |
| `where` | none | `{pathPrefix, ext[], modifiedAfter, minSize}` — metadata filters applied **before** paging. |
| `scope` | `workspace` | `workspace` (the caller cwd/session), `roots` (all configured roots) or `all` (also cross-workspace sessions when `allowCrossWorkspaceSessions`). |
| `limit` | `10` | 1–50. |
| `cursor` | — | Opaque `page.nextCursor`; mutually exclusive with `offset`. |
| `offset` | `0` | Legacy row offset; prefer cursors. |
| `maxChars` | profile `outputBudgetChars` (8,000 in DSH) | Item-character budget; the tool schema falls back to 6,000 without an embedder default; `0` = unlimited; below 120 is `budget-too-small`. |
| `detail` | `compact` | `compact` (identity + snippet), `standard` (+freshness/refStatus/language), `full` (+ids/hash/permissions/context). |
| `count` | `exact` | `exact`, `bounded` (never compute an expensive exact total) or `none` (omit counts entirely; no exact totals are computed). |
| `includeArchived` | `false` | Search archived sessions in body results too (0.23). |

### How `mode: 'auto'` works (0.23)

Auto is a **cross-source merge**, not "first non-empty source":

1. The sources are chosen from the query shape and `kinds`: the symbol index is queried for identifier-shaped queries (or when only `symbol` rows are requested; Markdown headings are excluded from symbol probes), the body index is queried when the query has a term the trigram index can serve (3+ code points), and the name index participates for `file`/`dir` rows.
2. Each source is fetched in batches; rows are merged by a stable rank: **symbol exact → body term/BM25 → symbol prefix → symbol substring → name prefix → name substring**. Ties keep source order (same as the MCP/CLI parity surface).
3. Rows with the same identity are merged into one item: files by path, symbols by path+line+title, sessions by `(sessionId, messageId)`. The merged item's `why` and `sources` arrays list every contributing source.
4. `resolvedMode` is the source that won, or `"mixed"` when several contributed.
5. The continuation cursor pins the consumed position of **every** source (cursor v2), so paging neither loses nor repeats rows.

A common word no longer stops at a wall of symbol declarations. If the body probe cannot run (content index off, still building, or query error), the page carries a coverage note (`auto-body-unavailable`, `auto-body-empty`, `auto-body-failed`).

### Counts and paging

- `counts.total` with `totalKind: exact|bounded|unknown`; `nameTotal`/`bodyTotal`/`symbolTotal` when known.
- Name-mode totals are exact name-index counts and **ignore `where`**; the page carries a `counts-ignore-where` note when that matters.
- `page.more=false` means there is no next page and no `nextCursor`; `page.returned` is the number of items after budget trimming.
- A cursor is bound to query, mode, scope and (auto) merge state. A cursor from another query answers `cursor-invalid`; re-run without the cursor.
- Auto pages use **cursor v2** `{v:2, mode, queryHash, offsets:{name,body,symbol}, scope, generation, kinds, includeArchived, seen?}` (base64url, opaque; `seen` is a bounded identity list so merged rows are never re-emitted). Single-source modes still emit v1 `{v:1, mode, queryHash, offset, scope, generation}` and accept v1 input; auto never emits a v1 cursor.
- An empty **workspace** first page is widened once to `roots` and echoed in `scope{fallback:true, fallbackReason}` plus a `scope-fallback` note. Pass `scope: 'roots'`/`'all'` explicitly to skip that step.

### CJK and short terms

- A **1-code-point** term is dropped when a longer term exists; the page carries a `terms-dropped` warning and the rest of the query still runs. A query made only of short terms answers `query-too-short` (or uses the bounded short fallback when `contentShortQueryFallback` is on).
- **2-code-point** terms no longer degrade the whole query: long terms go to FTS/BM25 and the short terms are enforced as a post-filter over the candidates. All-short queries use the bounded fallback (marker `shortQueryFallback`).

### Rows

Compact rows: `kind`, `path`, `title`, `line`, `snippet` (≤160 code points), `why[]`, `sources[]`, `score`, `ref`, `seq`/`eventRef` (session rows). `standard` adds `refStatus`, `freshness`, `language`, `symbolScope`; `full` adds `name`, `size`, `mtime`, `modified`, `ext`, `dir`, `format` (pdf/docx/xlsx/pptx/epub), `hash` (when cheap), `permissions`, `provenance`, `sessionId`, `messageId`, `context`, `contextStart`.

Session rows in `compact`/`standard` carry `eventRef` (and `seq`), so `locator_read` can read the matched message directly — the 0.22 find→read dead end is fixed.

### Coverage notes

`coverage.notes[]` are `{code, severity, message}`. Codes include `index-building`, `scope-fallback`, `scope-filtered`, `workspace-filtered`, `total-is-global`, `where-unverified`, `content-warnings`, `symbol-cap`, `budget-truncated`, `index-generation-changed`, `no-matches`, `auto-body-*`, `terms-dropped` (via content warnings). A note is **not** an error: the page is still usable, but its completeness is qualified.

## `locator_read`

| Parameter | Default | Notes |
|---|---|---|
| `ref` | — | One ref from `locator_find` (`ref://file?...`, `dsh-session:...`, `ref://session-event?...`, spill/attachment). |
| `refs` | — | 1–20 refs; duplicate strings are collapsed (`counts.duplicates`); per-ref failures appear as `item.error`. |
| `path` | — | Absolute file path inside the configured roots (no ref needed). |
| `line` | ref anchor / 1 | 1-based target line; the returned window always contains the target line whole. |
| `window` | `0` | Context lines on each side, 0–20. |
| `as` | `excerpt` | `meta` (evidence only), `excerpt` (verbatim whole lines), `quote` (markdown blockquote + citation link + fallback). |
| `maxBytes` | `2000` | Per-excerpt cap in characters (max 65,536); each excerpt is capped independently and the batch is not re-trimmed. |

Provide exactly one of `ref`, `refs[]` or `path`. Output: `items[]` with `ref/kind/title/path/line/startLine/endLine/excerpt/markdown/size/status/permissions/provenance/error` as applicable, plus `counts{requested,returned,failed,duplicates,linesDropped}`, `budget` and `limits{perExcerptChars,batchLimitChars,maxChars,maxRefs}`.

`locator_read` enforces the `notReadable` fence before opening any file: a denied path answers `scope-denied` and **no bytes or sizes are returned**. Directory paths are rejected with a remediation pointing at `locator_find kinds:['dir']`.

## `locator_status`

`detail: 'brief'` (default, ≤1,400 serialized characters) returns `summary`, `index{running,entries,files,dirs,watching,scanning,roots,watchDegraded}`, `content{enabled,building,files,sessions,messages,truncated}`, `scope{activeRules,outputBudgetChars,rerank,ocr}`, bounded `roots[]`, `warning` (truncated to 240 characters), `engineVersion`, `generation` and `truncated[]` (`warning`, `roots`). The brief now includes the engine warning (for example degraded watcher coverage) and the content `truncated` flag — it no longer reports "watcher active" while the full payload says otherwise.

`detail: 'full'` returns every legacy status field under `status`, including content diagnostics (`warningCounts`, `warningSamples`, `configResetSuspected`, `symbols`, `archivedSessions`, ...).

## `locator_admin`

Deferred maintenance tool (`deferLoading`), never part of the initial prompt:

| Action | Parameters | Notes |
|---|---|---|
| `rebuild` | `roots?`, `excludes?` | Background name-index rebuild; searches keep using the old index. Poll `locator_status` until `scanning:false`. |
| `reindex` | `full?` | Refresh the content index; `full:true` drops and rebuilds under the current caps. Poll until `content.building:false`. |
| `export` | `path?`, `overwrite?`, `allowOutsideStateDir?`, `pageSize?` | Write a read-only SQLite mirror of the name index. |

Parameters that do not apply to the chosen action are reported back as `ignored` instead of being silently dropped. Every action returns a `hint` and `nextTools` so an agent knows how to wait.

## Error codes

Twelve closed codes; `retryable` and `remediation` come from the code, `nextTools` suggests the unblocking tool:

| Code | Retryable | Meaning |
|---|---|---|
| `invalid-argument` | no | Parameter shape/range is wrong. |
| `query-too-short` | no | The body query is below the trigram floor. |
| `query-invalid` | no | Query syntax is not valid. |
| `scope-denied` | no | Path/session outside the allowed scope or matches `notReadable`. |
| `scope-empty-workspace` | no | The caller workspace has no indexed content; widen scope. |
| `not-found` | no | The requested path/ref does not exist. |
| `index-unavailable` | yes | Engine/index is not available; retry once, then check status. |
| `index-building` | yes | The first snapshot is still building; partial results may still be returned. |
| `budget-too-small` | no | `maxChars` cannot fit one item (minimum 120). |
| `cursor-invalid` | no | Cursor is malformed or bound to another query/mode/scope. |
| `cancelled` | yes | The request was cancelled. |
| `internal` | no | Unexpected failure; retry once, then check status. |

## HTTP `/v1` face

The same three read-only tools are reachable over the Web server (same trust fence as the panel routes):

```text
POST /dsh-locator/v1/find    { query, mode, kinds, where, scope, limit, cursor, maxChars, detail, count, includeArchived, pathPrefix? }
POST /dsh-locator/v1/read    { ref | refs[] | path, line, window, as, maxBytes }
POST /dsh-locator/v1/status  { detail: 'brief' | 'full' }
```

Rules specific to HTTP (there is no caller session identity):

- `find` defaults to `scope: 'roots'` (not `workspace`); `scope` may be `roots` or `all`, never a workspace.
- `kinds` may not contain `session`; session rows are never returned, counted or searched. Default kinds are file/dir/symbol.
- `read` accepts only file refs (`ref://file?...`) and absolute paths; session, spill, attachment and URL refs answer `scope-denied`.
- `admin` is never exposed.
- Unknown top-level arguments are rejected with `invalid-argument` instead of being ignored.
- A **tool-level** failure is HTTP `200` with `ok:false` in the envelope; only carrier errors are non-2xx (`405` method, `415` content-type, `400` bad JSON, `500` unexpected). A trust-fence rejection keeps the host's bare status code.

Legacy routes `/dsh-locator/search`, `/status`, `/combined`, `/reveal`, `/open`, `/capabilities` are unchanged. `/content` and `/content/rebuild` are deprecated in 0.23.0 (they return `deprecated:true` plus the headers `deprecation: true` and `x-dsh-locator-deprecated: remove-in-0.24.0`) and are removed in 0.24.0.

## Prompt cost

The three resident declarations are gated by the schema-budget test at **≤4,500 B** (0.23.0 measured `locator_find` 2,518 B + `locator_read` 1,405 B + `locator_status` 485 B = 4,408 B; 0.22 was 4,136 B). With `legacyTools: false` the legacy declarations are gone from prompt-caching/`run_code` tool listings as well; the 2026-11-27 pre-release measurement reports about 21 KB total instead of the 0.22 54,764 B when all legacy tools were injected.

## Parity and precedence

| Face | Search | Read | Status | Maintenance |
|---|---|---|---|---|
| Host tools (0.23 default) | `locator_find` | `locator_read` | `locator_status` | `locator_admin` (deferred) |
| Host tools (`legacyTools: true`) | + `locator_search`, `locator_explore`, `locator_symbol`, `locator_repo_map`, `locator_outline` | + `locator_resolve`, `locator_cite` | same | + `locator_rebuild`, `locator_reindex`, `locator_export` (deferred) |
| MCP default (legacy face, frozen) | `locator_search`, `locator_find` | `locator_resolve`, `locator_cite` | `locator_status` | never |
| MCP `--api=2026-11` | `locator_find` | `locator_read` | `locator_status` | never |
| CLI default | `search`, `find` | `resolve`, `cite` | `status` | never |
| CLI `--api=2026-11` | `find` | `read` | `status` | never |
| HTTP `/v1` | `find` | `read` | `status` | never |

When two faces disagree, the host tool contract on this page is authoritative; the CLI/MCP/HTTP faces are thin carriers that add their identity rules (see [cli-mcp.md](cli-mcp.md)).

## Worked example

```text
1. locator_find { query: 'retry policy', mode: 'auto', limit: 10 }
   -> page.more=true, page.nextCursor=<v2 cursor>, items[0].kind='file', ref='ref://file?...'
2. locator_find { query: 'retry policy', mode: 'auto', limit: 10, cursor: <nextCursor> }
   -> next page; sources are advanced independently, no row lost or repeated
3. locator_read { ref: items[0].ref, as: 'excerpt', window: 2 }
   -> verbatim lines around the match
4. locator_status { detail: 'brief' }
   -> 'engine running · 259000 entries ... · watcher active · content 164000 files ...'
```

For a session hit, `items[n].eventRef` goes straight into `locator_read { ref: eventRef, as: 'excerpt' }`; no second `find` is needed.
