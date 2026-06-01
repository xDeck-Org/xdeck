# xDeck-Org/xdeck — package release CI + schema host

This repo is the **CI/schema host** for every `xDeck-Org/xdeck-pkg-*` marketplace
package. It is **not** the xDeck product — the product monorepo lives at
`The-Freak-Geeks/xdeck` (a TheFreakGeeks product). This repo exists so package
repos in `xDeck-Org` can run their release gate **same-org**, without reaching
cross-org into a private TFG repo.

## What each `xdeck-pkg-*` repo calls

Every package repo's `.github/workflows/release.yml` fires on a `v*` tag and calls:

```yaml
uses: xdeck-org/xdeck/.github/workflows/package-release-reusable.yml@main
```

That reusable workflow (here) validates the tagged package against the same
hardenings the runtime resolver applies (ADR 0003 §6):

1. `package.json` validates against `libs/shared-types/src/package.schema.json` (ajv)
2. tag version `v<x.y.z>` matches `package.json#version`
3. repo name matches `xdeck-pkg-<name>` (soft warning)
4. content hardenings — `scripts/ci/package-content-validator.sh` (symlinks / submodules / LFS / size cap)
5. `classes/transforms/*.ts` type-check (if present)
6. capability-declaration static analysis — `scripts/ci/check-package-capabilities.js` + `libs/runtime-api/`

## Contents (vendored from `The-Freak-Geeks/xdeck`)

| Path | Canonical source |
| --- | --- |
| `.github/workflows/package-release-reusable.yml` | `The-Freak-Geeks/xdeck` @ same path |
| `libs/shared-types/src/package.schema.json` | ″ |
| `scripts/ci/package-content-validator.sh` | ″ |
| `scripts/ci/check-package-capabilities.js` | ″ |
| `libs/runtime-api/` | ″ (standalone lib — no monorepo deps) |

> **Sync note (drift risk):** these are a **vendored snapshot** of the canonical
> assets in `The-Freak-Geeks/xdeck`. When the package schema, content validator,
> or capability catalogue change there, re-vendor them here (a scheduled mirror
> job is the intended follow-up). Pin `xdeck-ref` to a release tag for prod
> stability.

## Launch-window posture

- **`capability-gate` default = `warn`** (the canonical default is `fail`). During
  the launch bootstrap window, capability-declaration mismatches are surfaced as
  warnings, not hard failures, because they are **also** enforced at install-time
  (`PackageValidatorService`) and by `npm run packages:validate-all`. Flip back to
  `fail` once all packages are clean.
- **Visibility: public.** The content is non-sensitive (the package schema's own
  `$id` is a public URL; the validators + capability catalogue are developer
  contract, not business logic). Public lets package-repo workflows check this
  repo out with the default `GITHUB_TOKEN` — no PAT/org-secret needed. Flip to
  private + a fine-grained `xdeck-checkout-token` org secret if you prefer.
