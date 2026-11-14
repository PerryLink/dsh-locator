# Release checklist

`dsh-locator` ships six prebuilt Go engine binaries inside the npm tarball, so a
release is more than `npm publish`: the six binaries, the CI result and the tag
must all point at the same commit. The workflow enforces that; this file is the
human checklist around it.

## Release rules (what the workflows enforce)

`release.yml` is a manual (`workflow_dispatch`) publish. It is **not** triggered
by tags, and it refuses to run unless all of the following hold:

1. **tag == HEAD == package version.** The dispatched tag (`vX.Y.Z`, default
   `v<package.json version>`) must exist in the checkout, point at the checked
   out commit, match `package.json`'s version, and be an ancestor of
   `origin/main`.
2. **The complete CI matrix for that exact SHA is green.** A `preflight` job
   asks the GitHub API for the `ci` runs with `head_sha == SHA` and fails unless
   the newest run finished `completed/success` **and** the newest `push` to
   `main` run did too. The old workflow published straight from whatever branch
   was selected; `0.9.0` was in fact published from a commit whose CI run had
   just failed, which this gate now prevents. The same publish also shows the
   engine-drift problem this workflow fixes: the `0.9.0` tarball on npm still
   contains engine binaries that report `0.7.0`, because no workflow ever
   rebuilt `bin/` for the new version. Rules 3–4 close that hole.
3. **The engine binaries are rebuilt from the tagged commit.** A matrix builds
   them from source (`engine/`), never trusting the committed `bin/`:
   * `ubuntu-latest` builds the static `linux-x64`, `linux-arm64`,
     `win32-x64`, `win32-arm64` binaries (`CGO_ENABLED=0`);
   * `macos-latest` builds `darwin-x64` and `darwin-arm64` with
     `CGO_ENABLED=1` so the FSEvents watcher is compiled in.
   The artifacts are downloaded into `bin/` in the publish job, so the tarball
   can never contain a binary built from another commit.
4. **The payload is verified and tested before publishing.** `scripts/verify.mjs`
   checks each of the six binaries embeds the package version, matches its
   directory's `GOOS`/`GOARCH`, and that darwin is the cgo/FSEvents build (the
   workflow runs it with `DSH_LOCATOR_REQUIRE_DARWIN_CGO=1`); the
   host binary is executed and must print `indexd <version> <goos>/<goarch>`.
   The full vitest suite then runs against those rebuilt binaries, and the
   actual `npm pack` tarball is inspected for all six engine files.
5. **Nothing is published twice, and the registry points back at the SHA.**
   The publish step fails if the version already exists on npm, and after the
   publish it polls `npm view dsh-locator@X.Y.Z gitHead` until it equals the
   release SHA (this is the tag == HEAD == npm `gitHead` assertion).

Dry runs are the default: leave the `publish` input unchecked and the workflow
stops after gates 1–4. Passing `publish=true` (or `-f publish=true` on the CLI)
is required to actually publish.

## Engine build matrix

| target | builder | `CGO_ENABLED` | notes |
| --- | --- | --- | --- |
| `linux-x64`, `linux-arm64` | `ubuntu-latest` | `0` | static, no libc dependency |
| `win32-x64`, `win32-arm64` | `ubuntu-latest` | `0` | cross-compiled, static |
| `darwin-x64`, `darwin-arm64` | `macos-latest` | `1` | links CoreServices/FSEvents |

**Do not run `pnpm build:engine:all` on Linux or Windows.** That script
cross-compiles darwin with `CGO_ENABLED=0` (the kqueue fallback) and silently
replaces the real macOS/FSEvents binaries in `bin/`. CI and release never call
the all-target script, and both run `verify.mjs` with
`DSH_LOCATOR_REQUIRE_DARWIN_CGO=1`, which rejects a kqueue darwin payload. A
plain `pnpm verify` on a machine that cannot build darwin with cgo prints a
warning instead of failing, so local development stays usable; the strict
option is the release gate. Use:

```sh
pnpm build:engine        # host platform only (cgo on macOS, static elsewhere)
```

and let the release workflow (or the CI `engine` jobs) produce the other five
targets. The committed `bin/` is a convenience for local development and is
verified by `pnpm verify`; the published tarball always uses freshly rebuilt
binaries.

## Before dispatching a release

1. Bump `version` in `package.json` and add a `## X.Y.Z — YYYY-MM-DD` heading to
   `CHANGELOG.md` (the release preflight requires the heading).
2. From a clean tree, run the local gates:
   ```sh
   pnpm install
   pnpm typecheck
   pnpm build
   pnpm test
   node scripts/verify.mjs       # must print "verify: OK — ..."
   npm pack --dry-run
   ```
   `verify` fails if any of the six `bin/` engines is stale or was built for the
   wrong `GOOS`/`GOARCH`. For a release-grade check, copy the
   `engines-darwin-cgo` artifact from the green CI run on the release commit
   into `bin/darwin-*` and run the strict gate:
   ```sh
   DSH_LOCATOR_REQUIRE_DARWIN_CGO=1 node scripts/verify.mjs
   ```
   That also rejects the kqueue darwin fallback. The release workflow rebuilds
   all six binaries from the tag anyway, so a stale committed `bin/` can never
   leak into the npm tarball; refreshing it keeps local packs honest.
3. Privacy gate (learned from 0.5.1): regenerate every screenshot from
   `/tmp/demo` fake data, open `docs/assets/*.png` and confirm no real home path
   is visible, and grep the shipped text for absolute paths:
   ```sh
   grep -rn '/home/[a-z0-9_-]*/\|C:\\Users\\' README*.md CHANGELOG.md cordis.patch.yml src client.js
   ```
   Unpublish is only possible within 72 hours and CDN mirrors keep serving the
   tarball afterwards (npmmirror still serves 0.5.1), so this check runs
   *before* the publish, not after.
4. Push the release commit to `main`, then **wait for the `ci` workflow on that
   commit to finish green**. CI now runs Node 22 and 24 on Windows, macOS and
   Linux, builds all six engines from source, and fails if the engine-dependent
   suites (`runtime.spec.ts`, `plugin.spec.ts`, `export.spec.ts`) execute zero
   tests — "no host binary, silently skipped" is no longer a passing state.
5. Tag and push the tag:
   ```sh
   git tag vX.Y.Z
   git push origin main vX.Y.Z
   ```

## Publish

Requires npm trusted publishing or the `NPM_TOKEN` repository secret, and the
`release` workflow needs `id-token: write` for provenance (already granted in
`release.yml`).

Dry run first (checks the tag, the green-CI gate, the rebuilt engines, verify,
tests and the tarball payload, then stops):

```sh
gh workflow run release.yml --ref vX.Y.Z -f publish=false
```

Then publish:

```sh
gh workflow run release.yml --ref vX.Y.Z -f publish=true
```

The workflow checks out the tag commit itself; do not dispatch it from an
unrelated branch.

## After publishing

```sh
npm view dsh-locator version dist.tarball gitHead
dsh plugin --profile web add dsh-locator
```

`gitHead` must equal the release commit SHA; the publish job already asserts it.
The `mirror` workflow mirrors `main` and the release tag to Gitee and GitCode
(independent jobs with bounded retries and `ls-remote` verification; a missing
token fails the mirror run instead of skipping it).

Manual fallback (only with the owner's approval, after all the gates above):

```sh
npm publish --access public --provenance
```

## Rollback

* npm: `npm deprecate dsh-locator@X.Y.Z "superseded"` and publish a fixed
  version; unpublish is only possible within 72 hours and breaks users.
* Install: `dsh plugin --profile web remove dsh-locator`; the snapshot stays in
  the platform cache directory and can be deleted separately.

## Discoverability

The DSH Discover tab ships no index source. To make the plugin appear there,
submit it to an index the user adds, for example the canonical
`awesome-dsh-plugin` registry (one entry per plugin, `dsh.bundle` + `dsh.client`
required). That is an external PR, not part of `npm publish`.

## npm staged publishing (2026-11)

npm may accept `npm publish` but keep the version in a **staging queue** that only becomes installable after a maintainer approves it with interactive 2FA (staged publishing is generally available; automation tokens that bypass 2FA can no longer publish directly). Symptoms: the publish step prints `+ dsh-locator@x.y.z`, the registry returns 404 for that version, and a retry fails with `E409 Cannot publish over previously staged version`.

- Approve from the npm website (package page → staged versions) or interactively with `npm stage list` + `npm stage approve <id>`.
- After approval, re-run the failed `publish` job: the workflow treats an already published version whose `gitHead` equals the release SHA as a no-op and finishes green.
- The release gate (tag, green CI, six rebuilt engines, verify, tests, tarball) runs **before** publishing, so a staged version is already fully verified.
