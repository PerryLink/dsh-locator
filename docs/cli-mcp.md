# CLI and MCP

Applies to `dsh-locator` **0.23.0**. Both surfaces are **read-only**: they never create, rewrite or append to the caller's state directory. File bodies come from an immutable SQLite connection, and the Go engine runs against a temporary copy of `index.snapshot` / `index.journal` / `meta.json` (reflink when the filesystem supports it).

Two npm bins are published:

| Bin | Entry |
|---|---|
| `dsh-locator` | `scripts/locator-cli.mjs` |
| `dsh-locator-mcp` | `scripts/locator-mcp.mjs` |

## State and roots resolution

Both bins resolve their configuration at startup (no profile config is read):

| Flag | Environment | Meaning |
|---|---|---|
| `--state <dir>` | `DSH_LOCATOR_STATE` | Engine state directory. Default: the platform cache directory. **`--state` without `--root` reads the roots recorded in `<state>/meta.json`**, which avoids a full rescan (measured: 52 ms / 259k entries vs 2,171 ms / 554k entries when re-scanning only `/home`). |
| `--root <dir>` | `DSH_LOCATOR_ROOTS` (path-separator separated) | Index roots to query; repeatable. Default: the environment list or the home directory. |
| `--bin <file>` | `DSH_LOCATOR_BIN` | Engine binary to use. Default: the bundled `bin/<platform>/indexd[.exe]`. |
| `--timeout <ms>` | `DSH_LOCATOR_SCAN_TIMEOUT` | Engine request timeout (default 15000). |
| `--cwd <dir>` | — | 2026-11 only: the caller workspace used by `scope: 'workspace'`. |

Roots are fixed at startup; no tool can widen them during a session.

## CLI: legacy default

The default command surface is unchanged from 0.22 so existing scripts keep working:

```sh
npx dsh-locator search "handoff ext:md" --json
npx dsh-locator find "retry policy" --context 2
npx dsh-locator status --json
npx dsh-locator resolve "ref://file?path=..." --excerpt
npx dsh-locator cite "ref://file?path=..." --format markdown
npx dsh-locator version
```

Options: `--json`, `--limit N`, `--offset N`, `--context N`, `--sort`, `--desc`, `--regex`, `--case-sensitive`, `--whole-word`, `--files-only`, `--dirs-only`, `--mode names|content`, `--allow-sessions`, `--format markdown|json|mention`, `--excerpt`, `--budget CHARS`.

Legacy exit codes: `0` ok, `1` runtime error, `2` usage error, `3` index/engine unavailable.

Content search is fenced to the configured roots and **hides session documents by default**; `--allow-sessions` opts in (the recorded session workspace must also be inside the roots).

## CLI: `--api=2026-11`

Opt-in versioned face; every command prints the shared 2026-11 envelope as JSON on stdout (pretty-printed), including failures:

```sh
npx dsh-locator find "retry policy" --api=2026-11 \
  [--mode auto|name|body|symbol] [--kinds file,dir,symbol] [--where '<json>'] \
  [--scope workspace|roots|all] [--limit N] [--cursor TOKEN] \
  [--detail compact|standard|full] [--max-chars N] [--count exact|bounded|none]

npx dsh-locator read <ref|path> --api=2026-11 \
  [--ref R] [--path P] [--refs R1,R2] [--as meta|excerpt|quote] \
  [--line N] [--window N] [--max-bytes N]

npx dsh-locator status --api=2026-11 [--detail brief|full]
```

- `--cwd` sets the workspace scope (default: the process cwd). When that directory is outside the configured roots, `scope: 'workspace'` falls back to `roots` and carries a coverage note — pass `--cwd` explicitly for stable workspace filtering.
- `--state` without `--root` reads the roots recorded in `meta.json`.
- `find` is the only search command; there is no `search`/`resolve`/`cite` alias on this face.
- Session rows are not exposed: results are files/dirs/symbols (`--kinds` accepts `file,dir,symbol`), and body searches hide session documents.
- `admin` (rebuild/reindex/export) is never exposed; use the host tool or the panel for maintenance.

2026-11 exit codes map the closed error set onto stable statuses: `0` ok, `1` internal/cancelled, `2` usage-class (`invalid-argument`, `query-too-short`, `query-invalid`, `cursor-invalid`, `budget-too-small`), `3` index unavailable/building, `4` denied/not found (`scope-denied`, `scope-empty-workspace`, `not-found`).

## MCP: legacy default (frozen)

`dsh-locator-mcp` speaks MCP over stdio and exposes five read-only tools by default: `locator_search`, `locator_find`, `locator_status`, `locator_resolve`, `locator_cite`. This is the 0.22 face and it stays frozen for compatibility; it is not scheduled to switch in 0.23.x.

```sh
npx dsh-locator-mcp
npx dsh-locator-mcp --state ~/.cache/dsh-locator          # roots from meta.json
npx dsh-locator-mcp --root /home/me --root /mnt/data
npx dsh-locator-mcp --cwd /home/me/project
```

## MCP: `--api=2026-11`

```sh
npx dsh-locator-mcp --api=2026-11
```

Exposes exactly `locator_find`, `locator_read` and `locator_status` with standard JSON Schema inputs/outputs generated from the host contract (the host DSL's property-level `required:true` is converted; it is not valid JSON Schema on the wire).

- **Sessions never appear**: the surface is files-only; `locator_find` returns file/dir/symbol rows and `locator_read` reads file refs/paths.
- **`locator_admin` is never exposed** by any MCP surface.
- **Failures** use the same envelope as the host tools and are also carried in `structuredContent`, with `isError: true`; text content is a human-readable rendering.
- **Protocol versions**: `2025-11-25` (latest), `2025-06-18`, `2025-03-26`, `2024-11-05`. An unknown/unsupported requested revision is answered with the **latest** supported version (not the oldest).
- **State**: `--state` without `--root` reads the roots recorded in `<state>/meta.json`; one long-lived engine serves the process against a temporary read-only copy of the state.

## Claude / Cursor configuration

Ready-made files: [`examples/mcp/claude.json`](../examples/mcp/claude.json) and [`examples/mcp/cursor.json`](../examples/mcp/cursor.json).

Claude Code (`claude mcp add` or a project `.mcp.json`) — the same JSON shape as `examples/mcp/claude.json`:

```json
{
  "mcpServers": {
    "dsh-locator": {
      "command": "npx",
      "args": ["-y", "dsh-locator-mcp", "--api=2026-11"]
    }
  }
}
```

Cursor (`.cursor/mcp.json`) — same shape as `examples/mcp/cursor.json`:

```json
{
  "mcpServers": {
    "dsh-locator": {
      "command": "npx",
      "args": ["-y", "dsh-locator-mcp", "--state", "/home/me/.cache/dsh-locator", "--api=2026-11"]
    }
  }
}
```

Substitute a real state directory for your platform in the Cursor example (`%LOCALAPPDATA%\dsh-locator` on Windows, `~/Library/Application Support/dsh-locator` on macOS, `~/.cache/dsh-locator` on Linux) or drop the `--state` pair to use the default. Use the **legacy** face (no `--api` argument) when your MCP client or prompt expects the 0.22 tool names; the files above opt into the versioned face because it has the stable envelope. On Windows use the full path to `npx.cmd` if your client does not resolve `.cmd` shims.

## Security notes

- Both bins are read-only by construction: engine state is copied to a per-process temporary directory, content databases are opened immutable, and the caller's state directory is never created or written.
- The MCP server never listens on a network port (stdio only) and never widens roots after startup.
- File bodies are still private data: keep `stateDir` permissions private, and remember that `--allow-sessions` (legacy CLI) makes session text searchable to the process.

## Verifying a CLI/MCP install

```sh
npx dsh-locator --version
npx dsh-locator status --json
npx dsh-locator-mcp --help
npx dsh-locator find "readme" --api=2026-11 --limit 1
```

A correct install answers `ok: true` in the 2026-11 commands and prints five legacy tools in the MCP legacy face (three in the versioned face).
