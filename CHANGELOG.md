# Changelog

## 0.1.0 — 2026-11-09

First working release.

* Go engine (`indexd`) with a persistent file index, parallel query matching and top-K selection.
* Serve-during-scan: a cold start answers searches from the partially built index (`indexing: true`) instead of blocking until the scan finishes; incomplete snapshots are marked and rescanned on the next start.
* Parallel scanner (bounded queue, per-directory batches, inline fallback) with exclude globs, progress and cancellation; snapshot save/load; tombstone compaction. Warm scan of 1.23 M entries dropped from 11.8 s to 6.5 s on the test machine.
* Linux inotify watcher (recursive) and Windows `ReadDirectoryChangesW` watcher (recursive, no admin).
* macOS gets a kqueue vnode watcher (directory-level creates/deletes/renames, capped at 4,096 watched directories) plus the periodic rebuild fallback; FSEvents is next.
* USN decoder and opt-in fast path (`internal/usn`): USN_RECORD_V2 parsing, FRN parent-map path reconstruction, journal read, `windowsUsn` / `--usn` MFT enumeration with automatic portable-walk fallback, page-level metadata fill for names-only records, and an `indexd usn-probe` elevated acceptance command. Off by default until the elevated probe is validated.
* Everything-style query language: bare terms, `!` negation, quotes, `*`/`?`, `ext:`, `path:`, `size:`, `dm:`, `folder:`, `file:`, `case:`, `wholeword:`.
* DSH plugin with `locator_search`, `locator_status`, `locator_rebuild`, a path-search result card and configurable roots/excludes/state.
* Global Web GUI search panel (`Ctrl+Shift+F`, sidebar magnifier): debounced live search, sortable columns, kind filters, keyboard selection, path copy, status footer. Served through same-origin host routes with the Web connection's own trust check; headless profiles simply omit it.
* Prebuilt engines for linux-x64, linux-arm64, win32-x64, win32-arm64, darwin-x64 and darwin-arm64.
* Go unit tests, plugin integration tests and a package verification script.
