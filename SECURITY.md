# Security

## Data and network surface

`dsh-locator` is local-only. The engine:

* never opens a network listener, never makes a network request, and has no telemetry;
* reads directory entries and file metadata (name, size, timestamps) under the configured roots;
* never writes, moves, renames or deletes an indexed file;
* stores its snapshot under `stateDir` (default: the platform cache directory).

The snapshot contains file names and paths. Treat the state directory as private data. Deleting it only costs one rebuild.

## Process model

The engine is a separate Go process started by the plugin with stdio pipes. It does not need admin rights, a service, a driver, or Everything. It exits when the plugin unloads (or after a 1.5 s grace period).

## Binaries

The npm package ships prebuilt engines for six platform/architecture pairs. They are built from `engine/` by `scripts/build-engine.mjs` with `-trimpath` and no cgo. Rebuild them yourself if you prefer not to trust the bundled artifacts:

```sh
pnpm build:engine:all
```

## Reporting

Open an issue at <https://github.com/PerryLink/dsh-locator/issues> without attaching snapshots, file lists, or anything else that reveals directory contents. For a sensitive report, say so in the issue and ask for a private channel first.
