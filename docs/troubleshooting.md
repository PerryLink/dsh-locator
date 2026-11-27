# Troubleshooting

Applies to `dsh-locator` **0.23.0**. Start with the [quick triage](#quick-triage), then jump to the symptom. If you are about to delete anything, read [Before you delete state](#before-you-delete-state) first.

## Quick triage

```text
# 1. Is the plugin installed and at the expected version?
npx dsh-locator --version                      # package version

# 2. Is the index healthy? (read-only; --state picks the state dir)
npx dsh-locator status --json

# 3. What does the host tool see?
locator_status { detail: 'brief' }              # roots, entries, watcher, content, warning

# 4. Read-only environment/profile diagnosis
node scripts/doctor.mjs --print-restore        # bundles, deps, patch, bin, stateDir, schema, disk, .bak-*
```

`locator_status` (brief) answers most questions in one line: it reports the engine warning (for example a degraded watcher), the content `truncated` flag and the roots. `detail: 'full'` adds content diagnostics (`warningCounts`, `warningSamples`, `configResetSuspected`, `symbols`, `archivedSessions`).

Where things live: the plugin logger writes `dsh-locator` lines to the DSH host log/console; the state directory contains `index.snapshot`, `index.journal`, `meta.json`, `content.db`, `content-config.json` and, since 0.23, engine copies under `engine/<version>/`.

## Installing and verifying

**I installed it but the version is still old.** On release day, `@latest` can resolve to the previous release when a `minimumReleaseAge` policy or a lagging npm mirror is involved. Pin the version explicitly (`dsh plugin --profile web add dsh-locator@0.23.0`) and confirm with `npx dsh-locator --version`. See [install.md](install.md#release-day-pinning-minimumreleaseage).

**How do I verify the install?** Run the five checks in [install.md](install.md#verify-the-install): binary version, `locator_status`, panel, state directory, and the 3+1 tool surface. A quick machine check is `npx dsh-locator status --json` (must return `ok: true`).

**The plugin is installed but no tools appear.** Check `dsh plugin --profile web list`; a missing bundle means a profile problem (see [Profile reset or lost bundles](#profile-reset-or-lost-bundles)). If the bundle is present, reload the page/restart the host — tools mount at plugin activation. Headless/TUI profiles have no panel by design.

## Panel and UI

**The panel does not appear after installing.** Reload the page (`F5`); confirm you installed into the `web` profile and that the panel is loaded from the boot graph. Headless/TUI profiles never mount a panel. If `/dsh-locator/status` answers while the panel is missing, the routes are fine and the client bundle did not load — reload and check the browser console.

**The panel shows an old tool surface or no content group.** The client bundle is served by the host; a stale page after an upgrade is fixed by `F5`. If panel routes answer `503`, the host `connection` service is missing or its check failed (fail-closed design); restart DSH. `httpConnectionOptional: true` is the documented fallback for hosts that do not inject the connection service during plugin boot.

## First run, time and disk

**The first content search takes forever / the index is "still building".** The content index is lazy and the first full build on a large home directory takes roughly **4–5 minutes** (0.20.2 measured 5m44s for ~163k candidate files / 2 GB budget). The build runs in the background; name results keep returning. `locator_status` reports `content building`, the panel shows progress.

**Disk usage is much bigger than my body budget.** The content database is not the sum of bodies: the live profile stored 1.74 GB of bodies in a **5.45 GB** `content.db`. Budget for roughly 3× the body budget, or lower `contentMaxTotalBytes`/`contentMaxFiles`, raise `contentRefreshMs`, or set `contentIndex: false` for name-only search. Deleting the state directory clears the cache (and forces a rebuild).

**The content build stopped with `content-disk-space-low`.** 0.23.0 added a disk preflight before a destructive rebuild (estimated database size × 1.25 + 256 MiB reserve). Free space on the state volume, or lower the content budget, then retry the rebuild. The old database is kept; search keeps working.

**A file created a moment ago is not found.** Notifications may not have arrived yet (common for WSL writes into `/mnt/c`, network shares and some container overlays). Wait a moment or run `locator_admin { action: 'rebuild' }` for that root. USN mode replays the journal on restart.

## Content search

**Content search returns nothing.** Check `coverage.indexing`/`content.building` first: the first search triggers the lazy build and results may be partial until it finishes. Then confirm the file type is indexable (text extension, or an extractable document: PDF/DOCX/XLSX/PPTX/EPUB with `contentExtractDocuments` on), the file is under `contentMaxFileBytes`, it is not excluded by `contentExcludes`/`notIndexed`, and the session is not archived (`includeArchived` per call or `contentIncludeArchived`).

**A 1–2 character query fails or behaves differently.** Body terms below 3 code points cannot use the trigram index. A 1-code-point term is dropped when a longer term exists (warning `terms-dropped`); a query made only of short terms answers `query-too-short` (or the bounded short fallback when enabled). Use `mode: 'name'` for short file-name fragments.

**The content database grows without a rebuild / a rebuild keeps repeating.** 0.23.0's config-drift guard keeps the database when the effective body cap shrinks and looks like a reset profile block (`content-config-reset-suspected` in status; `configResetSuspected: true` in the content diagnostics) instead of deleting and rebuilding it. Decide between keeping the smaller cap (eviction converges) and a forced rebuild with `locator_admin { action: 'reindex', full: true }`.

## Upgrade

**Behaviour changed after an upgrade.** Read [upgrade.md](upgrade.md#what-changed-in-0230); the two changes that surprise most callers are the 3+1 default surface (legacy tool names are off unless `legacyTools: true`) and `mode: 'auto'` merging sources (cursor v2).

**Upgrade fails with a locked engine binary on Windows.** Older versions (< 0.23.0) kept `bin\win32-x64\indexd.exe` open while running, so replacing the package in place could fail. 0.23.0 copies the engine under `stateDir/engine/<version>/` before spawning and no longer locks the installed file. One-time recovery from an older version: quit the DSH host normally, install again, start DSH. Do not kill the host process.

**After upgrading, `locator_status` shows a different engine version than the package.** That is the intended visibility: 0.23 exposes `engineVersion` next to the package version. A stale engine means the host is still running an old process — restart DSH. On Windows both versions are kept under `stateDir/engine/`; delete old version directories only when DSH is stopped.

**After upgrading, the content index looks empty or rebuilding once.** 0.23.0 does not change the content schema, so a normal upgrade reuses `content.db`. A rebuild still happens when the database is missing, corrupt, or left unfinished; it is incremental otherwise. Check `content.building` before assuming a problem.

## Profile reset or lost bundles

**Symptom:** tools and panel disappear, the profile bundle list looks shorter, the `dsh-locator` config block is gone, and the content index may start a large rebuild.

Known root cause (0.22): the profile config block was lost, the effective `contentMaxTotalBytes` fell back to the 1.6 GB schema default while the database held more, and the caps check deleted and rebuilt the index. 0.23.0's config-drift guard prevents the destructive rebuild, but it cannot restore a profile the host already reset.

Recovery, in order:

1. `dsh plugin --profile web list` — record which bundles are missing.
2. Inspect the profile patch for the `dsh-locator` entry/config; look for host-created `.bak-*` backups.
3. Run the read-only doctor from the plugin directory: `node scripts/doctor.mjs --print-restore` (add `--state`/`--root` when they are not the defaults). It checks the package, bundle patch, dependencies, engine binaries, state permissions and schema, quarantine/lock/temp files, last-good-profile records and disk space, and **prints** restore commands for a human. It never changes the profile and never restarts the host.
4. Compare with the last-good records (`stateDir/last-good-profile.json`, plus `.1`/`.2` rotations; 0600; written on each successful boot) and restore bundle names/config values by hand.
5. Re-add missing bundles, e.g. `dsh plugin --profile web add dsh-locator@0.23.0`, then reload the page.
6. Verify the index was not lost: `locator_status` should show the previous entry count; the state directory is independent of the profile.

**Do not** copy a `stateDir` from another machine, and do not delete it to "fix" a profile problem — that only forces a rebuild.

## Uninstall residue

**I uninstalled the plugin but the state directory is still there.** The DSH profile manager removes the package, not the cache. `stateDir` (platform cache directory by default) survives; delete it manually only while DSH is not running. It contains `index.snapshot`, `index.journal`, `meta.json`, `content.db`, `content-config.json` and per-version engines. If you want to keep the config but stop the plugin, prefer `enabled: false`.

## Platform-specific

**An `inotify` warning appears (Linux).** Too many directories hit the kernel watch limit; the index stays usable and changes rely on periodic refreshes. Raise `fs.inotify.max_user_watches` or reduce `roots`/`watchMaxDirs`.

**WSL writes into `/mnt/c` are not seen.** The Windows watcher cannot observe the 9p writer's change stream; the unwatched-root refresh covers those roots on a slower cadence, or rebuild that root explicitly.

**Network shares are stale.** They are scanned only when reachable as ordinary directories, and there is no SMB change feed; rely on the periodic refresh or rebuild.

**macOS: only 4,096 directories are watched.** That is the `CGO_ENABLED=0` kqueue fallback; release binaries use FSEvents. Content changes always rely on the periodic refresh on the fallback build.

**Windows USN/MFT does not activate.** It requires an elevated process and an active change journal; otherwise the portable walk is used with a warning. `size:`/`dm:` filters over a USN index are approximate until a metadata pass runs.

## Two processes, state and MCP

**Two DSH processes share one state directory.** 0.23.0 takes an exclusive engine write lock, so corruption is prevented, but they still cannot share one open database handle efficiently. Give each process its own `stateDir`.

**MCP/CLI cannot find anything / rescans everything.** Point them at the right state with `--state`/`DSH_LOCATOR_STATE`; `--state` without `--root` reads the roots recorded in `meta.json` and avoids a full rescan. `--root` fixes roots explicitly. Both are read-only: they copy the state and never write it.

**An MCP client reports an unknown protocol version.** Supported revisions are `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`; unsupported requests are answered with the latest. Upgrade the client or pin the revision in its MCP settings.

## Before you delete state

- The state directory is a **cache**, not user data: deleting it never touches indexed files.
- It is also **private data**: it contains paths, file bodies and session text. Delete it while DSH is stopped, and never move it to a shared drive.
- Deleting it forces a first scan (minutes) and a first content build (4–5 minutes on a large home). Prefer fixing the actual issue first.

## Getting help

Open an issue at <https://github.com/PerryLink/dsh-locator/issues> with: the output of `npx dsh-locator --version`, `locator_status { detail: 'full' }` (redact paths/body text you do not want to share), the doctor output and the relevant `dsh-locator` log lines. Do not attach `content.db` — it contains your file bodies and session text.
