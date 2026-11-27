# Performance and resources

This page records what was measured, how, and on what machine. Numbers are **historical measurements**, not guarantees: disk, file count, page-cache state and GC all change them.

- **Most recent full measurement:** 2026-11-21/22, `dsh-locator` 0.21.1/0.22.x.
- **0.23.0-specific figures:** the 2026-11-27 pre-release measurement covers the agent prompt/declaration cost only (see [Agent prompt cost](#agent-prompt-cost-0230)); 0.23.0 does not change the search paths, so the engine tables below remain the 0.22.x measurements.
- **Method:** WSL2 Ubuntu 24.04 on a laptop, ext4 over a warm page cache, one `/home/yy` root for name measurements; the live content figures use the maintainer profile (home + `/mnt/d`, 2 GB body budget). Wall clock from the tool envelope `timing.tookMs`, engine RSS from `/proc`, snapshot/database sizes from `stat`.

## Name index

| Metric | 0.19.4 | 0.21.1 |
|---|---|---|
| Cold scan (default cache exclusion) | 2.40 M entries / 16.4 s / 754 MB peak | **0.48 M entries / 1.4 s / 164 MB** (−80% entries, ~12× faster) |
| Snapshot size | 207 MB | **35 MB** |
| Load + derived tables | 143–156 ms / heap 268 MB | **85–108 ms / heap 186 MB** |
| Engine ready (incl. watcher) | ~2.4 s (150 k watches installed synchronously) | **~0.3 s** (watcher installs asynchronously) |
| Common queries (`locator_find` name mode) | func 13 ms / go 16 ms / `*.go` 21 ms / `ext:` 6.4 ms | **func 10.7 / go 6.0 / `*.go` 4.4 / `ext:` 3.3 ms** |
| Regex query | `config.*test` ~102 ms | **~11 ms** |
| Engine RSS (watcher installed) | ~700 MB | **~335 MB** (auto 512 MB limit) |
| Incremental save (1 000 changes) | full 163 MB rewrite, 144 ms write-lock hold | **70.9 KB, 0.35–0.5 ms** (base untouched) |
| Compact (~1.5 M entries) | ~0.9 s (864 ms write lock) / 850 MB peak | **120–190 ms (8–16 ms write lock) / 431 MB** |

The **0.48 M entries** row is the measurement configuration; a profile with a different root set or `includeCaches` has a different entry count. The maintainer's live profile (2026-11-22) reported 259,343 name entries and 480 session logs with the default cache exclusion.

## Content index

Live profile, 1–2 GB body budget (0.21.1 measurements):

| Metric | 0.19.4 | 0.21.1 |
|---|---|---|
| Common-word query (`the`, 30 hits) | 73 ms exact / 70 ms none | **5.3 ms / 1.6 ms** |
| Wide query (`the`) file share | 0% (sessions only) | **100%** (file-first grouped paging + light rerank) |
| Two-character query (`索引`) | rejected (too-short) | **works, ~30 ms** (bounded fallback + `shortQueryFallback` marker) |
| `function` (26.7 k hits) | 146 ms | **41 ms** |
| Rare-term query | 8.8 ms | 13 ms (no practical impact) |
| Incremental refresh (no change) | ~12 s | **<0.3 s** |
| Full rebuild | ~3.5 min (stopped early once the budget filled) | **5m31s** (two-phase planning + parallel prefetch + schema v4 + `/mnt/d`; 163 k candidates / 2 GB budget / 0 evictions) |
| Database size | ~4.1 GB (4.1× body budget) | **5.45 GB live** for 1.74 GB of bodies (schema v4 + idle vacuum; segments=1, freelist≈0) |
| Coverage | ~93.4 k files | **measured 163,791 / 163,951 = 99.9%**, 432 sessions / 4,492 messages |
| Host latency | Queries in a worker | `/combined` enrichment asynchronous; HTTP common-word query **~3 ms** |

0.23.0 does not change the build or query path (search paths are the 0.22 ones) except for the CJK term handling (`terms-dropped` / short-term post-filter), the disk preflight (defers a rebuild that would not fit) and the config-drift guard (skips destructive rebuilds after a suspected profile reset). The first full build is still expected to take about **4–5 minutes** on a large home directory.

## Memory

The engine is a single Go process that honours `GOMEMLIMIT`/`GOGC` and `memoryLimitMB`. `0` (the default) derives a limit from the machine (25% of RAM clamped to 384–1024 MiB). A 0.20 engine loads a 1.5 M-entry snapshot into ~186 MB of heap and settles around 335 MB RSS with the watcher installed (512 MiB limit); the previous release needed ~700 MB in the same spot. The snapshot format is unchanged.

With the content database page cache, the DSH host process sat around **700 MB RSS** in the live setup, with idle latency around p50 2 ms.

## Agent prompt cost (0.23.0)

Baseline measured on the 0.22.0 tree, 2026-11-22 (`JSON.stringify(name + description + parameters)`); 0.23.0 keeps the same three resident tools and gates the resident total at **≤4,500 B** with a schema-budget test (the exact 0.23.0 byte counts are recorded by the release CI report):

| Declaration | Bytes |
|---|---|
| `locator_find` | 2,311 |
| `locator_read` | 1,325 |
| `locator_status` | 500 |
| **Resident total (0.22.0 baseline)** | **4,136** (0.23.0 CI gate: ≤4,500) |

`locator_admin` and (when enabled) the legacy tools are deferred and stay out of the initial prompt. With `legacyTools: false` (0.23 default) the legacy declarations no longer appear in prompt-caching/`run_code` tool listings either: the 2026-11-27 pre-release measurement reports about **21 KB** total instead of the **54,764 B** measured in 0.22 with all legacy tools injected. The 0.22 claim that the 4,136 B figure applied to PTC/`run_code` was wrong; 0.23 fixes the cause instead of the promise.

## Tuning

- **Search only names**: `contentIndex: false` drops content work to zero and keeps RAM/disk minimal.
- **Keep content but use less disk**: lower `contentMaxTotalBytes` (e.g. `256000000`) or `contentMaxFileBytes`, or raise `contentRefreshMs`.
- **Cover more files**: raise `contentMaxTotalBytes`/`contentMaxFiles` and check that `contentExcludes` does not exclude real document trees. With `contentEvict` (default on) a full budget evicts the oldest documents instead of freezing.
- **Search toolchain caches too**: `includeCaches: true` restores the old entry count; or use `resourcePreset: 'eco' | 'balanced' | 'performance'`.
- **Disk headroom**: budget ~3× the body budget for `content.db` plus the rebuild headroom (current size × 1.25 + 256 MiB).

## Reproducing

```sh
# Names: warm the cache first, then time a page through the envelope
npx dsh-locator find "func" --api=2026-11 --mode name --limit 10   # timing.tookMs
npx dsh-locator find "go"   --api=2026-11 --mode name --limit 10

# Content: same envelope, body/symbol modes
npx dsh-locator find "索引" --api=2026-11 --mode body --limit 10

# Index statistics and build state
npx dsh-locator status --api=2026-11 --detail full
```

Treat differences below ~10–20% as noise on a laptop: run each query several times, keep the page cache warm, and record the machine, root set and budget with the numbers.

## Known limits

- First content build cost is the dominant one-time cost; it is CPU/disk bound and deliberately budgeted (see [config.md](config.md)).
- One engine process per DSH host; the content index runs in the host process with worker threads for queries.
- `content.db` size follows SQLite page sizes and FTS segments, not the raw body bytes; the 3× rule of thumb is for planning, not a hard limit.
