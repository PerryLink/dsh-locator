# Configuration

Every field is a [Schemastery](https://github.com/shigma/schemastery) config field. Override the `dsh-locator` entry in your profile patch:

```yaml
- id: dsh-locator
  name: dsh-locator
  config:
    roots: ['/home/me/Documents', '/home/me/notes']
    contentMaxTotalBytes: 2000000000
    contentExcludes: ['node_modules', '.git', '.cargo', 'site-packages']
```

Invalid values fail the profile load loudly instead of being silently guessed. Reload the page (Web profile) or restart the host after a change. Unknown keys are ignored by the loader but are a good sign of a typo — compare against this page.

The defaults below are the ones in 0.23.0. `resourcePreset` is applied on top of explicit values (see [Resource presets](#resource-presets)).

## Indexing and scope

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch; `false` mounts no tools and starts no engine. |
| `roots` | home directory | Directories to index; several may be given. |
| `excludes` | `node_modules`, `.git`, `.hg`, `.svn`, `.cache`, `__pycache__`, `.venv`, `venv`, `.next` | Base-name globs skipped by the name index. |
| `watch` | `true` | Apply native filesystem notifications. |
| `refreshIntervalMs` | `1800000` | Rebuild cadence when no native watcher is active; `0` disables it. |
| `refreshIncremental` | `true` | Fallback refreshes rescan only roots the watcher cannot cover; `false` restores a full rebuild. |
| `unwatchedRefreshIntervalMs` | `300000` | Split refresh cadence for roots without a watcher (9p/DrvFs); 2x backoff cap, worst-case staleness 10 min. |
| `scanWorkers` | `0` | Directory reader concurrency during scans; `0` uses the CPU count. |
| `memoryLimitMB` | `0` | Soft Go heap limit in MiB; `0` means auto (25% of RAM clamped to 384–1024 MiB). |
| `includeCaches` | `false` | Index well-known toolchain/package caches (`~/go/pkg/mod`, `.cargo*`, `.rustup`, `.local/lib`, pnpm store, ...). Off removes most entries on a typical dev home. |
| `watchMaxDirs` | `120000` | Total watched-directory budget; beyond it the periodic incremental refresh covers the tree. |
| `snapshotCompression` | `'none'` | Snapshot compression; `zstd` roughly halves the file but adds a few hundred ms to load and save. |
| `prewarm` | `true` | Start the engine during plugin activation (removes the first-request cold-start wait). |
| `windowsUsn` | `false` | Try NTFS USN/MFT enumeration before the walk (Windows, administrator; falls back automatically). |
| `stateDir` | `''` | Snapshot/content database directory; empty means the platform cache directory. Use a separate value per DSH process. |
| `resourcePreset` | `'balanced'` | `eco` / `balanced` / `performance` budget preset; explicit keys win (see [Resource presets](#resource-presets)). |
| `binaryPath` | `''` | Custom engine binary instead of the bundled `bin/<platform>/indexd[.exe]`. |
| `maxResults` | `100` | Page-size cap for the legacy search surface. |
| `startupTimeoutMs` | `120000` | Engine startup deadline. |
| `requestTimeoutMs` | `15000` | Engine request deadline. |
| `httpConnectionOptional` | `false` | Let the panel routes operate without the host `connection` service (still behind the host's request authentication and same-origin check). |
| `combinedBudgetChars` | `0` | `/combined` panel-response budget; `0` keeps the old unbudgeted behaviour. |
| `combinedEnrichConcurrency` | `8` | Parallel stat/hash enrichment limit for `/combined`. |
| `combinedHashMaxHits` | `5` | Maximum files hashed per `/combined` response; `0` disables hashes. |

## Content index

| Key | Default | Meaning |
|---|---|---|
| `contentIndex` | `true` | Build the file-body and session-message index at all; `false` leaves name search with near-zero content overhead. |
| `contentLazy` | `true` | Build the content index on the first content search instead of at plugin start. |
| `contentMaxFileBytes` | `1000000` | Bytes read from one text file. |
| `contentMaxTotalBytes` | `1600000000` | Total body bytes kept in the content database; `0` means unlimited. |
| `contentMaxFiles` | `200000` | Text files indexed per build; `0` means unlimited. |
| `contentMaxSessions` | `1000` | Most recent session logs indexed; `0` means all. |
| `contentMaxDbBytes` | `8000000000` | `content.db` budget, measured in live pages (not file size); oversize triggers one idle rebuild per six hours. |
| `contentRefreshMs` | `300000` | Incremental content refresh cadence; `0` disables it. |
| `contentIncludeArchived` | `false` | Include archived sessions in ordinary searches (archived logs are indexed either way; `locator_find` also takes a per-call `includeArchived`). |
| `contentActiveSessionDelayMs` | `120000` | Only index a session log after it has been quiet this long. |
| `contentSessionMaxBytes` | `67108864` | Largest session log read whole; bigger logs index only their head. |
| `contentSessionDirs` | `[]` | Extra session directories; empty means `$DSH_HOME/sessions`. |
| `contentExcludes` | dependency/toolchain names | Path segments or substrings the content index skips; the name index still covers them. |
| `contentIndexReasoning` | `false` | Index assistant reasoning/thinking blocks (toggling rebuilds session documents only). |
| `contentIndexToolResults` | `false` | Index `tool/result` text as its own session documents (toggling rebuilds session documents only). |
| `contentExtractDocuments` | `true` | Extract PDF/Word/Excel/PowerPoint/EPUB bodies (lazy, failures only warn). |
| `contentExtractMaxBytes` | `8000000` | Largest document handed to the extractor (worker thread, 512 MB heap, 5 s deadline). |
| `contentEvict` | `true` | Evict the oldest documents when the body budget is full instead of freezing the index. |
| `contentIndexSymbols` | `true` | Build the code-symbol store behind `locator_symbol`/`locator_outline`/`locator_repo_map` and `mode: 'symbol'`. |
| `contentSymbolsPerFile` | `500` | Symbols kept per code file. |
| `contentSymbolMaxBytes` | `524288` | Largest code file considered for symbol extraction. |
| `contentFullIndex` | `false` | One-switch full mode: overrides body/file caps to unlimited. |
| `contentRankAdaptive` | `true` | Skip bm25 ordering for wide result sets (order-of-magnitude faster on common words). |
| `contentQueryCacheSize` | `64` | Content search cache entries; `0` disables the cache. |
| `contentQueryCacheTtlMs` | `60000` | Content search cache TTL. |
| `contentRefreshAdaptive` | `true` | Reduce background indexing work when the machine is busy or on battery. |
| `contentParallelPrefetch` | `4` | Parallel read/decode/symbol workers during a full rebuild (1 disables, max 8). |
| `contentTextSniff` | `true` | Sniff extensionless files for text (4 KiB), raising coverage. |
| `contentShortQueryFallback` | `true` | Allow an all-short (≤2 code point) query to use a bounded approximate fallback. Mixed long + 2-code-point terms use FTS plus a post-filter (0.23). |
| `allowCrossWorkspaceSessions` | `false` | Whether `scope: 'all'` may read session bodies from other workspaces (default: authorize by caller cwd). |

## Agent surface

| Key | Default | Meaning |
|---|---|---|
| `legacyTools` | **`false`** (0.23) | Register the pre-0.22 tools again (`locator_search`, `locator_rebuild`, `locator_reindex`, `locator_export`, `locator_resolve`, `locator_cite`, `locator_explore`, `locator_outline`, `locator_symbol`, `locator_repo_map`), deferred out of the initial prompt. `false` keeps the 3+1 surface: `locator_find`, `locator_read`, `locator_status` + deferred `locator_admin`. |
| `outputBudgetChars` | `8000` | Default `maxChars` for `locator_find` and the per-tool-result character budget for the legacy tools; `0` disables the budget. |
| `notIndexed` | credentials | Globs never read into the content database (see [Privacy fences](#privacy-fences)). |
| `notSearchable` | `[]` | Globs never returned as hits by the legacy/content surfaces (still readable by `locator_read`). |
| `notReadable` | `[]` | Globs agents must not read: enforced by `locator_read`, `locator_resolve` and `locator_cite` (0.23.0), which answer `scope-denied` without reading bytes. |
| `rerankCommand` | `''` | Optional external rerank command (`rerank/v1` JSON stdin/stdout). |
| `ocrCommand` | `''` | Optional external OCR command (`ocr/v1` JSON stdin/stdout), used only for PDFs without a text layer. |
| `urlFreshness` | `false` | Let `locator_resolve` revalidate URL refs with one bounded conditional HTTP request. |

## Privacy fences

Three independent lists apply at different layers. All are glob lists matched against the file path/name:

- **`notIndexed`** (default: credentials) — never enters the content database at all. The defaults exclude `_key.*`, `发布令牌*`, `.env`, `.env.*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `id_ed25519*`. The name index still knows such files exist unless `excludes`/`notSearchable` also cover them.
- **`notSearchable`** (default: `[]`) — never returned as a hit by search tools, but still readable by `locator_read`/`locator_resolve` when a ref exists.
- **`notReadable`** (default: `[]`) — the strongest fence: an agent never receives bytes, excerpts, hashes or sizes from these paths. Name/symbol rows may still name such a path (without a `ref`; full detail reports `permissions.read = 'denied'`), body hits are dropped by the scope filter, and `locator_read`/`resolve`/`cite` answer `scope-denied` before opening the file.

These rules are operator policy, not a sandbox: they run inside the DSH host process and do not protect against a local user who can read the files directly. The state directory must still be private (see below).

## Config-drift guard and disk preflight (0.23)

0.23.0 keeps a small fingerprint of the last effective caps in `stateDir/content-config.json` (0600). If the effective body budget shrinks below what is stored and looks like a **reset profile block** (cap back at the 1.6 GB schema default, no explicit change), the plugin:

- keeps the existing `content.db` instead of deleting and rebuilding it;
- adds the `content-config-reset-suspected` warning (visible in `locator_status` full content warnings and in the panel);
- sets `configResetSuspected` in the content status;
- lets ordinary eviction converge to the smaller cap on later refreshes.

To force the old destructive rebuild after an intentional cap change:

```text
locator_admin { action: 'reindex', full: true }
```

A full rebuild also runs a **disk-space preflight**: if the state volume cannot hold the current database size × 1.25 plus a 256 MiB reserve, the rebuild is deferred (warning `content-disk-space-low`) instead of filling the disk halfway.

## State directory and permissions

`stateDir` holds `index.snapshot`, `index.journal`, `meta.json`, `content.db`, `content-config.json` and (0.23) per-version engine copies under `engine/<version>/` on Windows. Treat it as **private data**: it contains file paths, file bodies and session text.

- 0.23.0 creates the directory `0700` and the files `0600` on POSIX systems, and corrects existing ones idempotently at startup.
- On Windows no POSIX mode is meaningful; the directory inherits the user profile ACLs. Do not move `stateDir` to a share.
- Deleting `stateDir` is safe for source files (it is a cache) but forces a full rebuild; keep a separate `stateDir` per concurrently running DSH process.

## Resource presets

`resourcePreset` layers a coherent set of budgets:

| Preset | Effect |
|---|---|
| `balanced` (default) | Keep the documented defaults. |
| `eco` | Lower memory/content/refresh budgets; for laptops and battery. |
| `performance` | Raise them; for a desktop with spare RAM and disk. |

Explicit keys still win over the preset.

## Examples

**Small notes tree, no content index** — the cheapest useful setup:

```yaml
- id: dsh-locator
  name: dsh-locator
  config:
    roots: ['/home/me/notes']
    contentIndex: false
```

**Private documents with a hard read fence** — keep secrets out of the content DB and unreadable by agents:

```yaml
- id: dsh-locator
  name: dsh-locator
  config:
    roots: ['/home/me/work']
    contentExcludes: ['node_modules', '.git', 'private']
    notIndexed: ['.env*', '*.pem', '*.key', 'id_rsa*', 'secrets/**']
    notReadable: ['private/**', 'secrets/**']
```

**Large corpus on a roomy disk**:

```yaml
- id: dsh-locator
  name: dsh-locator
  config:
    roots: ['/home/me']
    includeCaches: true
    contentMaxTotalBytes: 4000000000
    contentMaxFiles: 400000
    contentMaxDbBytes: 16000000000
    contentParallelPrefetch: 8
```

**Laptop / battery**:

```yaml
- id: dsh-locator
  name: dsh-locator
  config:
    resourcePreset: 'eco'
    contentRefreshAdaptive: true
    contentRefreshMs: 900000
```

**Compatibility with 0.21-era agents and scripts**:

```yaml
- id: dsh-locator
  name: dsh-locator
  config:
    legacyTools: true
```

## Not configuration

- The CLI/MCP read their state from `--state`/`DSH_LOCATOR_STATE` and roots from `--root`/`DSH_LOCATOR_ROOTS` (or the recorded roots in `meta.json`); they do not read the DSH profile configuration. See [cli-mcp.md](cli-mcp.md).
- `notReadable` applies to the host tools and the HTTP `/v1` face. For the read-only CLI/MCP faces, files are already fenced to the configured roots and session documents are hidden by default.
