# Changelog

## 0.1.0 — 2026-11-09

First working release.

* Go engine (`indexd`) with a persistent file index, parallel query matching and top-K selection.
* Scanner with exclude globs, progress and cancellation; snapshot save/load; tombstone compaction.
* Linux inotify watcher (recursive) and Windows `ReadDirectoryChangesW` watcher (recursive, no admin).
* macOS has scan, snapshot and a periodic rebuild fallback; FSEvents is next.
* Everything-style query language: bare terms, `!` negation, quotes, `*`/`?`, `ext:`, `path:`, `size:`, `dm:`, `folder:`, `file:`, `case:`, `wholeword:`.
* DSH plugin with `locator_search`, `locator_status`, `locator_rebuild`, a path-search result card and configurable roots/excludes/state.
* Prebuilt engines for linux-x64, linux-arm64, win32-x64, win32-arm64, darwin-x64 and darwin-arm64.
* Go unit tests, plugin integration tests and a package verification script.
