# Changelog

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
