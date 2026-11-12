# Changelog

## 0.8.0 — 2026-11-12

Search and locate: all three stores in one panel, and a Word/Notepad++-style highlight in the conversation.

* **One combined search**: the new `POST /dsh-locator/combined` route queries content (bodies and sessions), files and folders in one request, keeps the old `/search` and `/content` routes for tools and compatibility, and returns grouped results in content → files → folders order with per-group counts. Paths found by both content and name are merged into the content row and counted.
* **All scopes on by default**: the panel now has three independent checkboxes (Content, Files, Folders), all checked; unchecking one narrows the search. Empty queries and one-character queries never start the lazy content build, so opening the panel stays cheap.
* **Conversation highlight**: double-clicking (or pressing Enter on) a session hit opens the conversation and paints the matched words with a translucent amber highlight (CSS Custom Highlight API, follows scrolling, centered on arrival). The scroll lock releases as soon as the reader scrolls or presses a key; `Esc` clears the highlight. Long sessions load older pages until the message is present, and `hidden="until-found"` rows are expanded with `beforematch`.
* **Panel rebuild**: grouped listbox with sticky group headers, per-group counts and truncation hints, relevance ordering for content and the sort menu for names, scope preference persistence, content-index progress with a retry, and light/dark theme tokens instead of `prefers-color-scheme`.
* **Keyboard and accessibility**: Enter activates the selected hit, `Ctrl+Shift+C` copies the path (Everything-style), `Ctrl+Shift+O` reveals it, `Alt+1–3` toggle scopes, Home/End/PageUp/PageDown move the selection, and a minimal dialog focus trap restores focus on close. Rows expose `role=option` / `aria-selected`; the panel is a combobox + listbox with a polite live region.
* Fixed: duplicate React keys for several session hits, the unstyled snippet line, and the fake content total. Tests: 37 unit tests (combined scope gating, merge/dedupe, lazy-build guards, plus the existing content/plugin suites); `scripts/verify.mjs` now also syntax-checks `client.js` and asserts the new route and highlight markers.
* No content-index schema change: upgrading does not rebuild the database. File-body hits still reveal the file in the file manager (line-level preview in DSH is the next step); assistant messages are located by phrase because their DOM rows carry no message id.

## 0.7.7 — 2026-11-11

Documentation release.

* README (zh/en) rewritten against the 0.7.x behaviour and measurements: stale content defaults (1 MB / 1 GB / 100 sessions, previously documented as 4 MB / 2 GB / 200), refreshed performance tables, corrected `locator_status` scope, comparison with Everything/Spotlight/grep, resource tuning, troubleshooting, version compatibility and roadmap.
* Spanish, Portuguese and Hindi READMEs brought to the same structure and section set.
* The npm package page therefore receives the current documentation; no runtime changes.

## 0.7.6 — 2026-11-11

Remaining-risk pass: sharing a cache directory, engine re-scans, and platform coverage.

* **Another DSH process replacing `content.db` is now detected**: the plugin remembers the file identity (device + inode) of its open handle and, on the next `status` or content search, closes the stale handle and reboots from the file now on disk. Previously it kept reading the unlinked database until the process exited. (Windows reports inode 0 on some filesystems; there the check is skipped instead of risking false positives.)
* **Content builds abort when the engine starts a re-scan**: the dump cursor is a record id, so an engine rebuild in the middle of a content build could mix pages; the build now stops, and the next incremental refresh retries against the new index.
* CI now runs the Node test suite on **Windows and macOS** as well as Linux (the Go engine already had a three-OS matrix).
* README notes that two DSH processes should use separate `stateDir` values: the build lock serializes writers, but it cannot share an open database handle.

## 0.7.5 — 2026-11-11

Hardening release from a full risk/bug pass against the real 3 GB content database.

* `deletePath` no longer scans every row: `docs_meta(path)` is indexed, so removing a rewritten session costs a lookup instead of ~10 ms of table scan (measured 6 ms before the index on 95k rows).
* A one- or two-character content query used to return full document bodies (up to a megabyte per hit); it now returns at most a 400-character excerpt. Matching rows are still found the same way, but the payload is bounded.
* A build interrupted by a crash, update, or forced reload is detected by the persisted `complete` flag and rebuilt on the next start instead of trusting a stale byte counter (which could let the body budget drift).
* The plugin refuses to delete a `content.db` it does not own (another tool in a shared `stateDir`); it reports an error instead of recreating the file.
* The state directory is created `0700`, `content.db` and `content.lock` are created `0600`, so indexed documents and session text are not readable by other local users.
* The build lock records the process start time as well as the pid, so a reused pid from an earlier incarnation cannot block builds for 30 minutes.
* The first lazy content query now reports `building: true` immediately (requested-start flag) instead of returning an empty page until the asynchronous boot opens the database.
* `boot()` skips a second pass when a content operation already built the database (for example `locator_reindex` right after a lazy start).

## 0.7.4 — 2026-11-11

* The content index is **lazy by default**: plugin startup now costs nothing for content. The first body/session search (`locator_find`, the panel's “搜内容”, or `locator_reindex`) starts the build in the background; `contentLazy: false` restores the eager background build. A restart that already has a database still refreshes incrementally on first use.
* Cordis-native scheduling: the boot delay and the incremental-refresh cadence now use the base profile's timer service (`ctx.timeout`/`ctx.interval` from `@deepseek-ai/cordis-plugin-timer`), so both disposers are owned by the plugin fiber; plain timers remain as a fallback when that service is absent.
* The panel reports “indexing” and re-polls while the lazy content build runs, so the first query fills in without retyping.
* Content builds are serialized by a `<stateDir>/content.lock` (per-instance token, stale locks taken over), so a profile HMR reload or a second DSH process can no longer run two writers against the same database and drift the byte counter.
* A full content rebuild now recreates `content.db` instead of running `DROP TABLE` over multi-GB FTS tables, which had been blocking the host for about a second at the start of a rebuild.
* The body-byte budget is now persisted in `content_meta` instead of rescanned at every refresh (a 1 GB database made `SUM(length(body))` block the host for ~0.6 s each time). Deleted bodies are subtracted, and files that no longer fit are retried after stale rows are removed. The schema version moves to 2, so an existing database rebuilds once.
* The content search worker is skipped when its compiled entry is absent (TypeScript test runs) and a failed/timed-out worker falls back to the in-process query instead of returning an empty page.

## 0.7.3 — 2026-11-11

* The content build no longer blocks the DSH host's event loop: file reads and session-log decompression are asynchronous and both build loops yield every ~8 ms (measured max event-loop gap on a 28.6 MB corpus: 968 ms → 19 ms). This is what made session loading and switching stall and could trip a WebSocket reconnect ("all sessions reloaded").
* Session logs are not chased while they are still being written: a log modified within `contentActiveSessionDelayMs` (default 120000) is indexed only after it has been quiet that long, instead of being fully decompressed and re-inserted every refresh.
* Archived sessions are skipped by default; set `contentIncludeArchived: true` to index them. Sessions deleted from disk disappear from the index on the next refresh as before.
* Lower default background load: `contentMaxFileBytes` 4 MB → 1 MB, `contentMaxTotalBytes` 2 GB → 1 GB, `contentMaxSessions` 200 → 100, `contentRefreshMs` 120 s → 300 s. All remain configurable.
* Tests: content-build event-loop cooperativeness, archived-session filtering, and active-session deferral.

## 0.7.2 — 2026-11-10

* A restart no longer rebuilds the whole content database: the plugin reuses `content.db` and refreshes it incrementally (measured 2.9 s on a 1.3M-entry index that took 7.4 min to build from scratch). A missing, stale-schema (`user_version`) or unreadable database still falls back to a full rebuild.
* Session jumps are anchored on the Chat node key (`data-chat-node-key` embeds the indexed `messageId`), so double-clicking a session hit outlines the exact message instead of the first copy of those words in the document (often the sidebar title). When the anchor is absent the panel falls back to a phrase search restricted to the conversation transcript and pulls older pages once.
* English, Spanish, Portuguese and Hindi READMEs document content search, incremental refresh, session jumps and the `content*` configuration; the stale "no content indexing" limitation is gone.

## 0.7.1 — 2026-11-10

* Content full builds index session messages **before** the much larger file set, so conversation search and jumps become available early.
* Content indexing skips the `.dsh` directory itself; it was re-indexing session projection caches and config as ordinary files.
* Incremental refresh keeps the same order.

## 0.7.0 — 2026-11-10

* Incremental content refresh: `docs_meta`/`sources` store each file/session mtime, so the 2-minute background refresh only re-reads changed sources.
* `locator_reindex` tool and `/dsh-locator/content/rebuild` route: incremental by default, `full: true` drops and rebuilds the database.
* `contentRefreshMs` config (default 120000; 0 disables auto refresh).
* Empty `contentSessionDirs` in tests no longer falls back to the real `$DSH_HOME/sessions`; an explicit empty list means no sessions.
* Engine rebuilt at 0.7.0 so `locator_status` no longer reports 0.5.3.

## 0.6.3 — 2026-11-10

* Content-index defaults enlarged 4×: `contentMaxFileBytes` 1MB → 4MB, `contentMaxFiles` 50k → 200k, `contentMaxSessions` 50 → 200. All remain configurable.
* New `contentMaxTotalBytes` (default 2GB) stops the build before the content database can grow without bound; `locator_find`/`/content` report `truncated`.
* README defaults/table updated.

## 0.6.2 — 2026-11-10

* Content database now creates `stateDir` before opening SQLite; a fresh profile with no engine snapshot yet no longer fails with `unable to open database file`.
* No other change.

## 0.6.1 — 2026-11-10

* The client now injects `uiWorkspace`, so double-clicking a session content hit actually calls `openSession(sessionId)` instead of falling back to copying the log path.
* Removed a temporary jump debug log.

## 0.6.0 — 2026-11-10

* Content search: text-file bodies and DSH session messages are indexed into a local SQLite FTS5 database; `locator_find` returns snippets plus `sessionId`/`messageId`.
* The panel has a “搜内容 / Content” mode. File hits open/reveal; session hits call `uiWorkspace.openSession(sessionId)` and scroll to the matched text.
* New `/dsh-locator/content` route; content build runs after the name scan and reports progress.
* Chinese README rewritten from scratch in natural Chinese, with the new content/jump behaviour documented.

## 0.5.3 — 2026-11-10

* `memoryLimitMB` config (and `indexd --memory-limit-mb`) applies a soft Go heap limit; 0 leaves `GOMEMLIMIT`/`GOGC` in charge.
* Panel close glyph is `×` instead of the missing `✕` symbol.
* Published through the provenance workflow (`npm publish --provenance`).

## 0.5.2 — 2026-11-10

* Replaced both README screenshots with demo data (`/tmp/demo`); the previous images exposed a home-directory path and have been withdrawn (npm 0.5.1 unpublished, tag/history rewritten).
* No code change.

## 0.5.1 — 2026-11-10

* README is now Chinese-primary (`README.md`) with full English (`README.en.md`), Spanish, Portuguese and Hindi translations; the old `README-zh.md` was replaced.
* Added a real panel screenshot (zh/en) and an architecture SVG under `docs/assets/`.
* Added the same centered header, install-channel matrix, mirror badges, official-repository note and star CTA used by the rest of the family.

## 0.5.0 — 2026-11-09

* **USN restart catch-up**: index records carry the NTFS FRN (in the old snapshot padding, so v1 snapshots still load), `scan --usn` persists `usn-state.json` (journal id, next USN, roots), and `serve --usn` replays the journal before serving. A file created while the daemon is stopped is found after restart without a full scan; a wrapped/mismatched journal falls back to the portable watcher. Validated on a Windows CI runner.
* **Panel i18n** (zh/en/es/pt/hi): follow `navigator.language`, including status, empty/error states, relative times and footer hints.
* **Panel actions**: `Ctrl+O` opens the selected file with its default app; `Ctrl+Enter` inserts a quoted `@"path"` into the composer (falls back to copying the mention); double-click still reveals it.
* `/dsh-locator/open` host route with the same root/path validation as reveal.

## 0.4.1 — 2026-11-09

* Engine version is injected at build time (`-X main.version`) instead of a hard-coded `0.1.0`; `locator_status` now reports the package version.
* `locator_export` verified against the live 1.24 M-entry index: 1,238,602 rows, 477 MB, 6.4 s.
* Memory tuning documented: Go honours `GOMEMLIMIT` / `GOGC`, so the engine can be capped without a rebuild (e.g. `GOMEMLIMIT=600MiB`).

## 0.4.0 — 2026-11-09

* macOS now ships **FSEvents** in the cgo darwin binaries (arm64 and x64): a pure-C stream callback serializes events into a pipe, so the recursive watcher has no per-directory descriptor limit. The previous crash was `FSEventStreamCreate` receiving the callback context instead of a real `FSEventStreamContext`.
* kqueue remains the `CGO_ENABLED=0` fallback and is used by the cross-built binaries in custom builds.
* CI builds the cgo darwin binaries on the macOS runner and the FSEvents create/delete test runs there.
* Replaces the 0.3.0 darwin binaries with the cgo builds; other platforms are unchanged.

## 0.3.0 — 2026-11-09

* Web panel: double-click a row to reveal it in the platform file manager (Explorer `/select`, Finder `open -R`, `xdg-open` on the directory). The path must be inside the configured roots and is passed as an argument vector, never through a shell; failure falls back to copying the path.
* DSH compatibility widened to `>=0.2.1-rc.2 <0.3.0` (peer `dsh-tools` `>=0.2.1-0`). Verified end to end on DSH 0.2.1-rc.5: plugin loads, reuses the snapshot, HTTP search answers, and the panel returns 964 matches in 24.4 ms with no console errors.
* `locator_export` and the rest of 0.2.x are unchanged.

## 0.2.1 — 2026-11-09

* Rebuild `lib/` before packing: 0.2.0's npm tarball was built from a stale
  `lib/` and did not contain `lib/export.js`. No source change.

## 0.2.0 — 2026-11-09

* `locator_export`: stream the index page by page and write a read-only SQLite mirror (`entries(path, name, dir, size, mtime_ms, ext)`) through Node's built-in `node:sqlite`. The compact snapshot remains the primary store.
* Engine `dump` RPC with a record-id cursor, so exports do not hold the index lock between pages.
* CI runs the engine build before the Node tests, exercising the new RPC and the clean-install path together.
* Windows USN path validated end to end on a Windows CI runner (1.34 M records, `C:\Windows` indexed in 7.8 s); macOS kqueue watcher covered by a macOS CI test.
* Experimental cgo FSEvents backend was attempted and removed after an arm64 `FSEventStreamCreate` crash; kqueue remains the shipped macOS backend.

## 0.1.0 — 2026-11-09

First working release.

* Go engine (`indexd`) with a persistent file index, parallel query matching and top-K selection.
* Serve-during-scan: a cold start answers searches from the partially built index (`indexing: true`) instead of blocking until the scan finishes; incomplete snapshots are marked and rescanned on the next start.
* Parallel scanner (bounded queue, per-directory batches, inline fallback) with exclude globs, progress and cancellation; snapshot save/load; tombstone compaction. Warm scan of 1.23 M entries dropped from 11.8 s to 6.5 s on the test machine.
* Linux inotify watcher (recursive) and Windows `ReadDirectoryChangesW` watcher (recursive, no admin).
* macOS gets a kqueue vnode watcher (directory-level creates/deletes/renames, capped at 4,096 watched directories) plus the periodic rebuild fallback; FSEvents is next.
* USN change feed: after MFT enumeration the engine polls the journal every two seconds and applies creates, deletes and renames through a tested pure applier (`usn.ApplyChanges`), updating the FRN path map in place.
* USN decoder and opt-in fast path (`internal/usn`): USN_RECORD_V2 parsing, FRN parent-map path reconstruction, journal read, `windowsUsn` / `--usn` MFT enumeration with automatic portable-walk fallback, page-level metadata fill for names-only records, and an `indexd usn-probe` elevated acceptance command. Off by default; the ioctl path, path reconstruction, journal read and the full `scan --usn` route are validated on a Windows CI runner.
* Everything-style query language: bare terms, `!` negation, quotes, `*`/`?`, `ext:`, `path:`, `size:`, `dm:`, `folder:`, `file:`, `case:`, `wholeword:`.
* DSH plugin with `locator_search`, `locator_status`, `locator_rebuild`, a path-search result card and configurable roots/excludes/state.
* Global Web GUI search panel (`Ctrl+Shift+F`, sidebar magnifier): debounced live search, sortable columns, kind filters, keyboard selection, path copy, status footer. Served through same-origin host routes with the Web connection's own trust check; headless profiles simply omit it.
* Prebuilt engines for linux-x64, linux-arm64, win32-x64, win32-arm64, darwin-x64 and darwin-arm64.
* Go unit tests, plugin integration tests and a package verification script.
