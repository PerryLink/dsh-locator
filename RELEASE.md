# Release checklist

Nothing here has been published yet. Do not publish without the owner's explicit approval.

## Current artifact

* `dsh-locator@0.1.0`, Apache-2.0, local git repo with prebuilt engines for six targets.
* `npm pack --dry-run`: 8.4 MB tarball, 44 files (engine binaries, `client.js`, `lib/`, docs).
* Verified: Go tests (including `-race` on the concurrent packages), plugin integration tests, `tsc`, `scripts/verify.mjs`, a real Web profile boot, and a headless-Chromium pass over the search panel.
* Verified live install: the tarball was installed into the running `/home/yy/.dsh/profiles/web` profile; the host hot-mounted `locator_search`/`locator_status`/`locator_rebuild`, the engine built a 1,221,872-entry snapshot, and the panel in the live GUI at 3081 answered a `report` query with 960 matches in 11.9 ms (headless Chromium, no console errors).
* Verified install path: `npm pack` tarball installed into a fresh Web profile (`dsh plugin --profile <name> add ./dsh-locator-0.1.0.tgz`), profile booted on a spare port, `POST /dsh-locator/search` answered, the client bundle appeared in the boot graph, and the panel worked in headless Chromium with no console errors.

## Before publishing

1. Rebuild everything from a clean tree:
   ```sh
   pnpm install
   pnpm typecheck
   pnpm test
   pnpm build
   pnpm build:engine:all
   node scripts/verify.mjs
   npm pack --dry-run
   ```
2. Bump `version` in `package.json` and add a `CHANGELOG.md` entry.
3. Confirm the repository URL exists (`github.com/PerryLink/dsh-locator`) and the README renders.
4. Optional but recommended: run the elevated Windows probe (see README) so the USN fast path is not shipped unvalidated. Keep `windowsUsn: false` as the default either way.

## Publish

Prefer a GitHub Actions release workflow with `--provenance`; the token stays in the repository secret, never in a local file or shell history.

Manual fallback (only with the owner's approval):

```sh
npm publish --access public --provenance
```

Then verify:

```sh
npm view dsh-locator version dist.tarball
dsh plugin --profile web add dsh-locator
```

## Discoverability

The DSH Discover tab ships no index source. To make the plugin appear there, submit it to an index the user adds, for example the canonical `awesome-dsh-plugin` registry (one entry per plugin, `dsh.bundle` + `dsh.client` required). That is an external PR, not part of `npm publish`.

## Rollback

* npm: `npm deprecate dsh-locator@0.1.0 "superseded"` and publish a fixed version; unpublish is only possible within 72 hours and breaks users.
* Install: `dsh plugin --profile web remove dsh-locator`; the snapshot stays in the platform cache directory and can be deleted separately.
