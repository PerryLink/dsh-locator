# Upgrading dsh-locator

Applies to **0.23.0** (2026-11-27). Installation basics are in [install.md](install.md); the release history is in [CHANGELOG.md](../CHANGELOG.md).

## Before you upgrade

1. **Pin the version** you want. On release day `@latest` can resolve to the previous release when a `minimumReleaseAge` policy or a lagging npm mirror is in play:

   ```sh
   dsh plugin --profile web add dsh-locator@0.23.0
   ```

2. **Check free space** on the state volume. The 0.23.0 upgrade itself does not rebuild the content database, but explicit maintenance or a corrupt database does; a full rebuild needs roughly the current `content.db` size × 1.25 plus a 256 MiB reserve.
3. **Copy the profile patch** (`cordis.patch.yml` or the profile equivalent) before changing bundles. It is the only place the plugin configuration lives.
4. Read [What changed in 0.23.0](#what-changed-in-0230) below, especially the default tool surface and the HTTP deprecations.

## Procedure

```sh
dsh plugin --profile web add dsh-locator@0.23.0
```

Then reload the Web page (`F5`). Headless/TUI profiles pick the new plugin up on the next host start. No action is needed for a profile that was already using the content index: the schema is unchanged in 0.23.0 and an existing `content.db` is reused incrementally.

Verify with the checklist in [install.md](install.md#verify-the-install). In particular `locator_status` (brief) should report `engineVersion`/`generation` and the same entry count as before the upgrade.

## What changed in 0.23.0

### Default agent surface is now 3+1 only

`locator_find` / `locator_read` / `locator_status` remain resident, `locator_admin` stays deferred (`deferLoading`), and the pre-0.22 tools are **no longer registered by default**. They remain callable only when the profile sets `legacyTools: true` (they then load deferred):

```yaml
- id: dsh-locator
  name: dsh-locator
  config:
    legacyTools: true
```

Affected names: `locator_search`, `locator_rebuild`, `locator_reindex`, `locator_export`, `locator_resolve`, `locator_cite`, `locator_explore`, `locator_outline`, `locator_symbol`, `locator_repo_map`. Tool prompts, agent instructions and scripts that call those names need either the flag or a migration to the 3+1 tools (see [agent.md](agent.md)).

### `mode: 'auto'` now merges sources

Before 0.23.0, auto resolved to the **first non-empty** source, which let common words be hijacked by symbol matches. 0.23.0 merges the sources its `kinds` allow (symbol declarations, body hits, file/dir names) into one ranked page: symbol exact matches first, then body term/BM25 matches, then symbol prefix/substring, then name prefix/substring. Rows with the same identity are merged into one item whose `why` and `sources` arrays list every contributing search.

- `resolvedMode` reports the mode actually used, or `"mixed"` when a page came from several sources.
- The continuation cursor is now **v2** in auto mode (per-source offsets). Single-source modes keep emitting v1 cursors and accept v1 cursors; an auto-mode query never returns a v1 cursor.
- CJK/short-term handling changed: a 1-code-point term is dropped when a longer term exists (coverage warning `terms-dropped`), and mixed long + 2-code-point terms are served by FTS plus a JS post-filter instead of degrading the whole query.

### Status brief is informative, not optimistic

The brief (`locator_status` default) now includes the engine warning (for example degraded watcher coverage on 9p/DrvFs roots), the configured roots (bounded to 4 with `truncated: ["roots"]`) and the content `truncated` flag. The serialized size ceiling rose from 600 to 1,400 characters to fit it.

### HTTP `/v1` and deprecated panel routes

The versioned HTTP face is new: `POST /dsh-locator/v1/find`, `POST /dsh-locator/v1/read`, `POST /dsh-locator/v1/status` answer the same envelope as the tools, are files-only (session rows are hidden and `read` accepts only file refs/absolute paths) and never expose admin.

`/dsh-locator/content` and `/dsh-locator/content/rebuild` are **deprecated** and return `deprecated: true` plus the headers `deprecation: true` and `x-dsh-locator-deprecated: remove-in-0.24.0`, with `replacement` pointing at `/v1/find` and `/v1/status`. They are kept for the panel for one more minor release and are removed in 0.24.0. `/dsh-locator/search` is unchanged.

### CLI and MCP

Both keep their legacy defaults so existing scripts do not break; they gain an opt-in versioned face:

```sh
npx dsh-locator --api=2026-11 find "retry policy" --limit 10
npx dsh-locator --api=2026-11 read <ref>
npx dsh-locator --api=2026-11 status
npx dsh-locator-mcp --api=2026-11   # find/read/status over MCP, admin never exposed
```

`dsh-locator-mcp` also learns the `2025-11-25` MCP protocol revision and answers unknown revisions with the newest supported one instead of the oldest. See [cli-mcp.md](cli-mcp.md).

### Security and state-directory permissions

- `locator_read`, `locator_resolve` and `locator_cite` now enforce the `notReadable` fence: a denied path answers `scope-denied` and its bytes are never read or returned.
- The state directory is created `0700` and `index.snapshot` / `index.journal` / `meta.json` / `content.db` / `content-config.json` are created `0600`; existing files are corrected idempotently at startup (POSIX modes; on Windows the profile's ACLs apply and no POSIX mode is set).
- CLI and MCP remain genuinely read-only: they run against a temporary copy of the engine state and an immutable content database.

### Content budget shrink no longer deletes the database (config-drift guard)

In 0.22 an effective `contentMaxTotalBytes` that fell below the stored bodies (a reset profile config block falls back to the 1.6 GB default) made the next refresh **delete and rebuild** a multi-GB index — the live incident was a 5.5 GB rebuild.

0.23.0 detects that shape (cap back at the platform default, stored bodies over it, no explicit change from the operator) and keeps the database: it records `content-config-reset-suspected` in the content warnings, sets `configResetSuspected` in the content status and lets normal eviction converge. An explicit full rebuild still forces the destructive path:

```text
locator_admin { action: 'reindex', full: true }
```

### Operations

- **Windows engine copy**: the engine binary is copied under `stateDir/engine/<version>/` before spawning, so an in-place upgrade no longer fails when the previous `indexd.exe` is still open. `locator_status` exposes the running `engineVersion` (and `generation`); compare it with the installed package version — a mismatch is now visible instead of silent.
- **`meta.json`** carries the scan statistics, last refresh time and platform; a missing or unreadable `meta.json` is rebuilt from the snapshot instead of forcing a full rescan.
- **Write lock**: the engine takes an exclusive lock on the state directory, so two processes cannot corrupt one snapshot by accident. Two DSH processes should still use separate `stateDir` values.
- **Disk preflight**: a full rebuild is deferred with `content-disk-space-low` when the state volume cannot hold the estimated database plus a 256 MiB reserve.
- **Release assets**: GitHub Releases now attach the published tarball and `sha256sums.txt`, so offline installs no longer depend on npm.

## Windows: engine file lock during upgrade

Symptom: upgrading an **older** (< 0.23.0) install fails or the plugin keeps running the old engine because `bin/win32-x64/indexd.exe` is open by the running host.

- On 0.23.0 this is fixed by the per-version engine copy described above; the installed `bin/` file is only the source.
- For a one-time recovery from an older version: quit the DSH Web host, install the new version, then start DSH again. Do **not** kill the host `node` process; if you must free the engine binary, close DSH normally and let it clean up.

## Profile reset or lost bundles

Symptom: the plugin's tools/panel disappear, `dsh plugin --profile web list` no longer shows `dsh-locator` (or shows other bundles missing), and the config block is back to defaults. The state directory may be intact, but the content index can look like it is rebuilding.

Known root cause (0.22): the profile's `dsh-locator` config block is lost, `contentMaxTotalBytes` falls back to the 1.6 GB schema default, the stored bodies are larger, and the caps check rebuilt the content database. The 0.23.0 config-drift guard prevents that destructive rebuild, but it cannot restore a profile that the host already reset.

Recovery (read-only diagnosis first):

1. `dsh plugin --profile web list` — see which bundles are present.
2. Inspect the profile patch for a `dsh-locator` entry and its `config:` block; check for host-created `.bak-*` files next to it.
3. Run the read-only doctor from the plugin directory:

   ```sh
   node scripts/doctor.mjs --print-restore
   # add --state <dir> / --root <dir> when they are not the defaults
   ```

   It checks the package manifest, the bundle patch, peer dependencies, the compiled `lib`, the six engine binaries, state-directory permissions, snapshot/journal/meta, the content schema and warning counters, quarantine archives, stale temporary files, the engine write lock, the last-good-profile records and free disk space. `--print-restore` prints recovery commands for a human; the script **never changes the profile** and never restarts the host (exit code 1 means at least one error-level finding).
4. Compare with the last-good records: `stateDir/last-good-profile.json` plus two rotations (`last-good-profile.1.json`, `last-good-profile.2.json`), newest first, written 0600 on each successful boot. Each record stores the package/engine version, platform, Node version, indexed roots, boot warnings and a sanitized configuration snapshot — use it to restore bundle names and configuration values by hand.
5. Re-add missing bundles, for example `dsh plugin --profile web add dsh-locator@0.23.0`, then reload the page.
6. Confirm the index did not need a rebuild: `locator_status` should show the previous entry count; the content database is independent of the profile.
7. If `content-config-reset-suspected` is reported, decide between keeping the current cap (eviction converges) and an explicit `locator_admin { action: 'reindex', full: true }` (rebuild under the new cap).

Do **not** copy a `stateDir` from another machine or another DSH installation; it is machine-specific private data. Do not delete `stateDir` to "fix" a profile problem — it only forces a rebuild.

## Downgrading

Downgrading is possible but not supported as a first-class path. Keep in mind:

- 0.23.0 emits v2 cursors in auto mode; 0.22.x only understands v1, so a stored cursor answers `cursor-invalid` after a downgrade — re-run the query.
- The content schema is unchanged across 0.22.3 → 0.23.0, so a downgrade does not rebuild it by itself.
- Set `legacyTools: true` before downgrading if your scripts call the old tool names, and remove the key from the profile after downgrading (0.22.x does not know it).

## Release assets

Each release publishes:

- the npm package `dsh-locator@0.23.0`,
- the GitHub Release tarball `dsh-locator-0.23.0.tgz` plus `sha256sums.txt`,
- six engine binaries inside the tarball, rebuilt from the tagged commit and verified by `scripts/verify.mjs` in CI.

See [RELEASE.md](../RELEASE.md) for the maintainer-side checklist.
