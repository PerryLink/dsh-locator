# Installing and verifying dsh-locator

This page covers installation, first run, verification and removal for `dsh-locator` 0.23.0.
For upgrade steps and behaviour changes see [upgrade.md](upgrade.md); for configuration keys see [config.md](config.md).

## Requirements

- **Node** `^22.19.0 || >=24.9.0` (the versions `package.json` declares).
- **DeepSeek Harness** 0.2.x; the release is verified against `dsh-v0.2.3-alpha.1` (2026-11-22).
- **No Go, no Everything, no `es.exe`.** The npm tarball ships prebuilt engines for `linux-x64`, `linux-arm64`, `win32-x64`, `win32-arm64`, `darwin-x64` and `darwin-arm64`.
- A Web profile if you want the `Ctrl+Shift+F` panel; headless/TUI profiles get the tools and the HTTP routes only when their host exposes a Web server.

## Install

```sh
# Pin the exact release (recommended on release day, see below)
dsh plugin --profile web add dsh-locator@0.23.0

# Or let the profile manager resolve latest
dsh plugin --profile web add dsh-locator

# Straight from the GitHub repository (main branch)
dsh plugin --profile web add github:PerryLink/dsh-locator
```

After installing into a **running** Web profile, reload the page (`F5`): host tools usually mount immediately, but the browser panel is resolved from the boot graph when the page loads. Headless/TUI profiles never mount the panel.

### Release-day pinning (`minimumReleaseAge`)

If your npm client or the profile manager enforces `minimumReleaseAge` (or your registry mirror lags), `@latest` can silently resolve to the **previous** release on the day a version ships. Always pin the exact version when you need 0.23.0:

```sh
dsh plugin --profile web add dsh-locator@0.23.0
```

Confirm the installed version with `npx dsh-locator --version` (it prints the package version).

### Offline / tarball install

Since 0.23.0 every GitHub Release attaches the published tarball next to `sha256sums.txt`:

```sh
# Linux / macOS
curl -LO https://github.com/PerryLink/dsh-locator/releases/download/v0.23.0/dsh-locator-0.23.0.tgz
curl -LO https://github.com/PerryLink/dsh-locator/releases/download/v0.23.0/sha256sums.txt
sha256sum -c sha256sums.txt --ignore-missing
dsh plugin --profile web add /absolute/path/to/dsh-locator-0.23.0.tgz
```

```powershell
# Windows PowerShell
Get-FileHash .\dsh-locator-0.23.0.tgz -Algorithm SHA256
# Compare the value with the one in sha256sums.txt before installing
dsh plugin --profile web add C:\absolute\path\to\dsh-locator-0.23.0.tgz
```

From a checkout:

```sh
pnpm install
pnpm build
pnpm build:engine        # host platform; build:engine:all needs the Go toolchain
dsh plugin --profile web add /absolute/path/to/dsh-locator
```

### Registry/mirror caveat

If your npm mirror lags, add `--registry=https://registry.npmjs.org` to the install command (or set it for the profile manager). A version that is missing from the mirror is not a plugin bug.

## Verify the install

Run these checks in order; each one is read-only.

1. **The binary runs**: `npx dsh-locator --version` prints `0.23.0`; `npx dsh-locator status --json` returns JSON with `ok: true` (CLI/MCP bind the config from `--state`/`DSH_LOCATOR_STATE` and are read-only).
2. **The plugin mounted**: in DSH ask for `locator_status` with `detail: 'brief'`. The brief reports the roots, entry counts, watcher state and whether the content index is enabled.
3. **The panel exists** (Web profile): press `Ctrl+Shift+F`; on a fresh install the first scan is still running and the footer says the index is building.
4. **The state directory exists**: see the platform table below. `index.snapshot` + `meta.json` appear after the first scan; `content.db` appears only after the first content search (the content index is lazy by default).
5. **The tool surface is the 0.23 default**: the initial tool list contains `locator_find`, `locator_read`, `locator_status` (plus the deferred `locator_admin`). Pre-0.22 tool names such as `locator_search` are **not registered by default**; see [legacy tools](#legacy-tools).
6. **Optional deeper check**: `node scripts/doctor.mjs --print-restore` from the plugin directory is a read-only diagnosis of the package, engines, profile patch, state directory and disk; it prints recovery commands instead of changing anything.

## First run

On first mount the engine indexes the configured roots (default: your home directory) and writes its state to the platform cache directory:

| Platform | Default state directory |
|---|---|
| Windows | `%LOCALAPPDATA%\dsh-locator` |
| macOS | `~/Library/Application Support/dsh-locator` |
| Linux | `$XDG_CACHE_HOME/dsh-locator` or `~/.cache/dsh-locator` |

Requests are served **during** the first name scan: results are partial and carry `indexing: true` (`coverage.indexing` in the agent envelope, `locator_status.index.scanning`).

### First content build: expect minutes and several GB

The content index is lazy: nothing is built at plugin start, and the first content search (`locator_find` with `mode: 'body'`/`'auto'`, or the panel's Content scope) starts the build in the background.

- On a large home directory the first **full** content build takes roughly **4–5 minutes** (0.20.2 measured 5m44s for ~163k candidate files / 2 GB body budget; 0.21.0 optimisations target ~4–5 min). Small roots finish in seconds.
- Disk use is about **3x the body budget** in practice: the maintainer's live profile kept 1.74 GB of bodies in a **5.45 GB** `content.db` (schema v4, segments=1). A default 1.6 GB budget therefore needs several GB of free space on the state volume.
- 0.23.0 adds a disk-space preflight before a destructive rebuild: if the volume lacks the estimated space (current database size × 1.25 plus a 256 MiB reserve), the rebuild is deferred and the index reports `content-disk-space-low` instead of failing halfway.
- While it builds, `locator_status` (brief) reports `content building`; the panel shows progress in the content group while name results return immediately.

Defaults skip `node_modules`, `.git`, `.hg`, `.svn`, `.cache`, `__pycache__`, `.venv`, `venv`, `.next` in the name index, and more dependency/toolchain directories in the content index. See [config.md](config.md#indexing-and-scope).

## Upgrade

Use the normal profile command, then reload the page:

```sh
dsh plugin --profile web add dsh-locator@0.23.0
```

The 0.23.0 upgrade is **content-schema compatible**: no full content rebuild is required by the plugin itself. A rebuild can still be triggered by a missing/corrupt database or by explicit maintenance; see [upgrade.md](upgrade.md) for the full procedure, the Windows engine-lock note and the profile-reset recovery steps.

## Uninstall

```sh
dsh plugin --profile web remove dsh-locator
```

- The plugin stops registering tools and routes on the next host start/reload.
- **The state directory is not removed** by the profile manager. Delete it manually only when DSH is not running (it is a cache: `index.snapshot`, `index.journal`, `meta.json`, `content.db`, `content-config.json`, and on Windows the per-version engine copies under `engine/`).
- To keep the configuration but disable the plugin, set `enabled: false` in the profile `dsh-locator` config instead of removing it.

## Platform notes

- **Windows**: no admin rights and no Everything are needed. If another process has the previous engine binary `indexd.exe` open, an in-place upgrade of an **older** plugin could fail; 0.23.0 copies the engine into `stateDir/engine/<version>/` before spawning it, so upgrades no longer depend on the installed file being replaceable. Optional `windowsUsn: true` (elevated) enables the USN/MFT fast path.
- **macOS**: the shipped binaries are built with cgo/FSEvents. A `CGO_ENABLED=0` build falls back to kqueue, capped at 4,096 directories.
- **Linux**: inotify uses one watch descriptor per directory; very large trees can hit `fs.inotify.max_user_watches`. The index stays usable and reports a warning.
- **WSL**: writes from the Windows side into `/mnt/<drive>` may not raise inotify events; the unwatched-root refresh covers them with a slower cadence, or rebuild that root explicitly.

## Legacy tools

0.23.0 keeps the pre-0.22 tool names available only when the profile opts in:

```yaml
- id: dsh-locator
  name: dsh-locator
  config:
    legacyTools: true
```

`legacyTools: true` registers `locator_search`, `locator_rebuild`, `locator_reindex`, `locator_export`, `locator_resolve`, `locator_cite`, `locator_explore`, `locator_outline`, `locator_symbol` and `locator_repo_map` again (deferred, so they stay out of the initial prompt). The default `false` keeps the 3+1 surface: see [agent.md](agent.md).

## Next

- [agent.md](agent.md) — the 2026-11 tool contract.
- [cli-mcp.md](cli-mcp.md) — command line and MCP server.
- [config.md](config.md) — every configuration key.
- [performance.md](performance.md) — measurements and tuning.
- [troubleshooting.md](troubleshooting.md) — when something is missing or slow.
