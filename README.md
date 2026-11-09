# dsh-locator

[GitHub](https://github.com/PerryLink/dsh-locator) · [Gitee](https://gitee.com/perrylink/dsh-locator) · [GitCode](https://gitcode.com/PerryLink/dsh-locator)

[![npm](https://img.shields.io/npm/v/dsh-locator)](https://www.npmjs.com/package/dsh-locator)
[![ci](https://github.com/PerryLink/dsh-locator/actions/workflows/ci.yml/badge.svg)](https://github.com/PerryLink/dsh-locator/actions/workflows/ci.yml)

[English](README.md) | [中文](README-zh.md) | [Español](README-es.md) | [Português](README-pt.md) | [हिन्दी](README-hi.md)

A whole-disk, millisecond file search for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) that builds its **own** index. No Everything installation, no `es.exe`, no Everything service.

`dsh-locator` scans the directories you choose once, keeps the result in a compact snapshot, applies filesystem changes as they happen, and answers name/path queries in tens of milliseconds across a million entries. The agent gets `locator_search`, `locator_status` and `locator_rebuild`; people get a global **search panel** in the Web GUI (`Ctrl+Shift+F` or the magnifier at the sidebar foot) with sortable columns, filters, keyboard navigation and one-key path copy.

Everything inspired the *ideas*: a persistent index of file names, a query language with `ext:` / `size:` / `dm:` filters, and an updater that consumes the filesystem's own change stream. The implementation is independent and cross-platform.

## Why another file search

`glob` and `grep` walk the workspace on every call — fine when you know the directory, slow when you remember only part of a name. Everything is excellent on Windows but is Windows-only, and wrapping it leaves macOS, Linux, WSL and remote hosts uncovered. `dsh-locator` owns the index, so the same tools work everywhere Node and Go run.

## Install

```sh
# from npm
dsh plugin --profile web add dsh-locator

# from a checkout
pnpm install
pnpm build            # TypeScript plugin
pnpm build:engine     # Go engine for the host platform
dsh plugin --profile web add /absolute/path/to/dsh-locator

# from a packed tarball (verified install path)
npm pack
dsh plugin --profile web add /absolute/path/to/dsh-locator-0.1.0.tgz
```

The npm package ships prebuilt engines for `linux-x64`, `linux-arm64`, `win32-x64`, `win32-arm64`, `darwin-x64` and `darwin-arm64`.

After installing into a Web profile that is already running, **reload the page** (`F5`): the host tools may mount immediately, but the browser panel (`client.js`) is loaded from the boot graph at page load. Headless/TUI profiles never mount the panel.

## First run

On first mount the engine indexes the configured roots (default: your home directory) and writes a snapshot to the platform cache directory:

| Platform | Default state directory |
|---|---|
| Windows | `%LOCALAPPDATA%\dsh-locator` |
| macOS | `~/Library/Application Support/dsh-locator` |
| Linux | `$XDG_CACHE_HOME/dsh-locator` or `~/.cache/dsh-locator` |

The first scan of a large home directory reads the disk; later starts load the snapshot instead. Requests are served **during** that first scan: search returns the entries indexed so far with `indexing: true`, and the panel footer says the index is still building. Nothing blocks on the cold scan. A default exclude list skips `node_modules`, `.git`, `.svn`, `.hg`, `.cache`, `__pycache__`, `.venv`, `venv` and `.next`.

## Web search panel

Press `Ctrl+Shift+F` anywhere in the Web GUI, or click the magnifier at the sidebar foot. The overlay queries the same index through two same-origin host routes (`POST /dsh-locator/search`, `POST /dsh-locator/status`), so it needs no second server and no extra port.

* Empty query lists the most recently modified entries; typing runs the same Everything-style syntax as the tool after a 110 ms debounce.
* Click a column header to sort by name, size, modification time or path; toggle ascending/descending.
* `只看文件` / `只看目录` filter the kind; the footer reports matches, the page cap and query latency.
* `↑`/`↓` select, `Enter` copies the selected path, `Ctrl+O` opens it, `Ctrl+Enter` inserts a quoted `@"path"` into the composer, **double-click reveals it** in Explorer/Finder/`xdg-open`, `Esc` closes.
* The panel follows `navigator.language` (zh/en/es/pt/hi).
* The panel is optional: profiles without a Web server never mount it, and the three tools keep working.

## Tools

| Tool | What it does |
|---|---|
| `locator_search` | Query the index. Returns path, size, modification time, extension and kind, plus total/truncated so a capped page is never presented as complete. |
| `locator_status` | Roots, entry counts, watcher state, state directory and engine path. Use it to explain coverage or diagnose a stale result. |
| `locator_rebuild` | Replace the index with a fresh background scan. Searches keep using the old index until the new one is ready. |
| `locator_export` | Write a read-only SQLite mirror of the index (`entries` table) for external SQL tools. Streams page by page; the binary snapshot stays primary. |

### Query language

Bare words are ANDed substrings of the file name. Everything-style filters combine with them:

| Example | Meaning |
|---|---|
| `report` | name contains `report` |
| `report ext:pdf` | …and the extension is `pdf` |
| `ext:ts,js` / `ext:!tmp` | include or exclude extensions |
| `*.sln` / `?ata` | `*` and `?` wildcards |
| `"annual report"` | phrase with a space |
| `!archive` | negate a term |
| `path:src` | the full path contains `src` |
| `size:>10mb` / `size:1kb..2mb` | size comparisons |
| `dm:today` / `dm:thisweek` / `dm:2026-01-01` | modification time |
| `folder:` / `file:` | directories or files only |
| `case:1` / `wholeword:1` | case-sensitive / word boundaries |

`locator_search` also takes `sort` (`name`, `path`, `size`, `mtime`, `ext`), `desc`, `offset`, `limit`, `regex`, `caseSensitive` and `wholeWord` parameters.

## Configuration

Every field is a Schemastery config field; edit the `dsh-locator` entry in the profile patch (or the bundled `cordis.patch.yml` defaults).

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Mount no tools and start no engine when `false`. |
| `roots` | `[]` | Directories to index; empty means the home directory. |
| `excludes` | dev/cache directories | Base-name globs skipped by scanner and watcher. |
| `watch` | `true` | Apply native filesystem notifications. |
| `refreshIntervalMs` | `1800000` | Rebuild cadence when no native watcher is active (kqueue fallback or a watcher failure); `0` disables. |
| `scanWorkers` | `0` | Directory reader concurrency during scans; `0` uses the CPU count. |
| `windowsUsn` | `false` | Try the NTFS USN/MFT enumeration before the walk (Windows, administrator; falls back automatically). |
| `stateDir` | `''` | Snapshot directory; empty means the platform cache directory. |
| `binaryPath` | `''` | Override the bundled engine (development). |
| `maxResults` | `100` | Hard cap for one search page. |
| `startupTimeoutMs` | `120000` | How long a cold build may take before the plugin reports failure. |
| `requestTimeoutMs` | `15000` | Per-request deadline. |

Narrow `roots` if indexing the whole home directory is too much I/O. A small, focused set (`~/Documents`, `~/Downloads`, one code tree) is usually the best trade-off.

## Platform support

| Platform | Scan + snapshot | Live updates | Notes |
|---|---|---|---|
| Linux | yes | inotify, recursive | Watch descriptors are per directory; very large trees can hit `fs.inotify.max_user_watches`. |
| Windows | yes | `ReadDirectoryChangesW`, recursive | No admin rights and no Everything needed. Optional USN/MFT enumeration when running elevated. Changes made by WSL to `/mnt/<drive>` may not raise notifications; use `locator_rebuild` for those. |
| macOS | yes | FSEvents in the shipped cgo binaries, recursive and uncapped | kqueue is the `CGO_ENABLED=0` fallback (up to 4,096 directories). File content changes do not raise vnode events in the fallback, so size/mtime refresh comes from `refreshIntervalMs` or `locator_rebuild`. |

The engine is pure Go except the macOS FSEvents backend, which uses cgo and is built on a macOS runner. Linux, Windows and the kqueue fallback build with `CGO_ENABLED=0`; USN is optional and needs admin rights, everything else does not.

### Windows and the USN journal

The engine carries a USN decoder, an opt-in fast path and a probe. The path is **off by default** (`windowsUsn: false`) because the volume ioctl needs administrator rights; it has been validated end to end on a GitHub Actions Windows runner (administrator, real NTFS volume):
- 1,345,546 MFT records read, 1,345,539 paths resolved
- 164,209 entries under `C:\Windows` (122,915 files, 41,294 dirs)
- `scan --usn --root C:\Windows` indexed 164,216 entries in 7.8 s; a query returned in 9.6 ms
- the change journal was read (8,233 records on one run) and an inactive journal on `D:` fell back to the walk with a warning

You can still run the same probe yourself:

```powershell
# Elevated PowerShell (or: Start-Process -Verb RunAs <path> ...)
& ".\bin\win32-x64\indexd.exe" usn-probe --volume C: --root "C:\Windows" --limit 5 --journal 5
```

It prints the journal id/USNs, enumerates the MFT (records per second, files/dirs below the root, sample paths) and decodes the last few change-journal records. A non-elevated run fails with `Access is denied` — the parser and path reconstruction are covered by unit tests on every platform.

With `windowsUsn: true` (or `indexd scan --usn`) the engine enumerates the MFT instead of walking directories, then builds paths from the FRN parent map. A successful USN scan also writes `usn-state.json` (journal id, next USN, roots) and keeps the FRN in each record; on the next `serve --usn` the engine replays the journal from that cursor before answering, so files created while it was stopped appear without a full scan. A wrapped, deleted or mismatched journal falls back to the portable watcher. It keeps the volume handle and polls the change journal every two seconds, applying creates, deletes and renames through `usn.ApplyChanges` (the same FRN map, updated in place). USN records carry **no size or modification time**: results are correct for names and paths, `locator_status` marks such an index with `USN`, and the daemon stats the returned page so the rows the panel/model sees still show real sizes and dates. `size:`/`dm:` filters over the whole index stay approximate until a metadata pass runs. Any failure (no elevation, unsupported volume, too many records) falls back to the portable walk with a warning; it never disables search. If journal polling fails mid-session, the watcher reports it and stops; the portable `ReadDirectoryChangesW` watcher and `locator_rebuild` are still there. The journal applier is covered by synthetic-record tests and the ioctl path by the Windows CI job.

Everything reads the NTFS Master File Table through the USN journal, which is why its first index is nearly instant. `dsh-locator` keeps a portable directory walk as the default (no service, no UAC, any filesystem) and uses USN/MFT as an opt-in fast path where the process holds `GENERIC_READ` (admin), with journal replay across restarts. The portable path stays the fallback.

## Performance

Measured on a developer WSL2 machine with a Linux home directory (1,234,757 entries: 1,128,288 files, 106,469 directories), excluding `node_modules`, `.git`, `.cache` and `.venv`:

| Metric | Result |
|---|---|
| Cold scan (uncached I/O) | 50.3 s |
| Warm scan (page cache, 8 readers) | 4.6–6.5 s (~190–265k entries/s) |
| Snapshot size | 133 MB |
| Peak scan RSS | ~490 MB |
| First search during the initial scan | 2 ms (partial, `indexing: true`) |
| `locator_search "report"` (981 matches) | 34 ms |
| `locator_search "package.json"` (1,287 matches) | 25 ms |
| Query process RSS (1.2 M entries) | ~197 MB |
| Small tree (39k entries) scan | 0.47 s |

Search is parallel over the record array; the slower cold scan is disk-bound. Numbers vary with the filesystem, cache state and CPU.

## Design

```
DeepSeek Harness
  └─ dsh-locator (TypeScript plugin)
       ├─ locator_search / locator_status / locator_rebuild
       ├─ client.js: Ctrl+Shift+F overlay (shell.overlay slot)
       ├─ POST /dsh-locator/{search,status} (same-origin, loopback-hosted)
       └─ child process: indexd serve  (Go, NDJSON over stdio)
            ├─ scanner: recursive walk, excludes, progress
            ├─ index:   names arena + fixed records + open-addressing path table
            ├─ query:   parser, matcher, top-K selection, sort, pagination
            ├─ watcher: inotify (Linux) / ReadDirectoryChangesW (Windows)
            └─ snapshot: single file, mmap-friendly, atomic rename
```

* **Parallel scanner.** Directory readers drain a bounded work queue and flush one batch per directory (`AddBatch`), so a parent record exists before its children are enqueued. The queue never blocks: a full queue falls back to scanning that subtree inline.
* **Memory layout.** Records store a name offset/length into one byte arena plus a parent id; full paths are reconstructed only for the result page and for `path:` filters. That avoids one string header per file.
* **Path table.** An open-addressing table of `id+1` slots keeps lookup/update near 12 bytes per entry instead of the ~50 bytes a `map[string]int32` costs.
* **Query engine.** Bare terms and filters are compiled once, matched in parallel chunks, then reduced with a bounded max-heap: the top `offset+limit` rows are selected without sorting a million matches.
* **Persistence.** The snapshot is written to a temporary file and renamed; a generation counter lets the daemon autosave only when the index changed. Tombstones are compacted when deletions exceed a threshold.
* **Protocol.** One JSON request/response per line on stdio, with unsolicited `scan`, `stats`, `warning`, `error` and `rebuilt` events. No ports, no auth surface, no network listeners.
* **Read-only.** The engine opens files for metadata only; it never writes to indexed paths.

## Build from source

Requirements: Node `^22.19 || >=24.9`, pnpm, Go 1.22+ for the engine.

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm build:engine:all   # or build:engine for the host target
```

The engine is a separate Go module under `engine/`; run its tests with `cd engine && go test ./...`.

## Limitations (v0.1)

* File names, paths, sizes and modification times only — **no content indexing**. Use `grep` for contents.
* The index covers configured roots; it is not a filesystem driver.
* Linux inotify watches one descriptor per directory; a home directory with hundreds of thousands of directories can exceed the kernel limit. The plugin reports the warning and the snapshot stays usable; rebuilds catch up.
* WSL writes into `/mnt/c` may not produce Windows notifications (the Windows watcher cannot see the 9p writer's change stream). Rebuild those roots explicitly.
* Network shares are scanned only if they are reachable as ordinary directories; no SMB-specific change feed.
* macOS uses FSEvents (recursive) in the shipped binaries; a `CGO_ENABLED=0` build falls back to kqueue, capped at 4,096 directories. Content-only changes rely on the periodic rebuild either way.
* Windows USN/MFT is optional and only used when the process can read the volume and the journal is active; otherwise the portable walk is used.

## Roadmap

1. Electron desktop runtime check on a real Windows install.
2. Richer previews and result grouping in the panel.
3. Windows on ARM / Linux ARM runtime coverage.
4. Optional lowercase-name arena and trigram prefilter for large indexes.
5. Incremental snapshot compaction and per-root journals.

## Memory

The engine is a single Go process and honours the standard `GOMEMLIMIT` and `GOGC` environment variables. A 1.24 M-entry index peaks around 700–800 MB RSS with the default GC; set `GOMEMLIMIT=600MiB` (soft limit, the runtime trades CPU for memory) or `GOGC=50` when the host is tight on RAM. Neither changes the snapshot format.

## Security and privacy

The index is local: no network calls, no telemetry, no uploads. The snapshot contains file names and paths, so treat the state directory as private data and exclude it from backups if that matters to you. The plugin never modifies, moves or deletes indexed files.

## License

Apache-2.0.
