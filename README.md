# xDeck-Org/xdeck — package release CI + schema host

This repo is the **CI/schema host** for every `xDeck-Org/xdeck-pkg-*` marketplace
package. It is **not** the xDeck product — the product monorepo lives at
`The-Freak-Geeks/xdeck` (a TheFreakGeeks product). This repo exists so package
repos in `xDeck-Org` can run their release gate **same-org**, without reaching
cross-org into a private TFG repo.

## What each `xdeck-pkg-*` repo calls

Every package repo's `.github/workflows/release.yml` fires on a `v*` tag and calls:

```yaml
uses: xdeck-org/xdeck/.github/workflows/package-release.yml@main
```

That reusable workflow (here) checks the tagged package against the same rules
the platform applies when it installs a package (ADR 0003 §6). In order:

1. `package.json` validates against `libs/shared-types/src/package.schema.json` (ajv)
2. every `entities/*.entity.json` validates against `libs/shared-types/src/entity-dsl.schema.json` (ajv)
3. privacy lint — a record kept about a person names that person (`scripts/lint-engagement-subject.js`)
4. sharing-rule lint — a sharing rule decides by permission, never by a role name (`scripts/lint-package-sharing-roles.js`)
5. tag version `v<x.y.z>` matches `package.json#version`
6. repo name matches `xdeck-pkg-<name>` (warning only)
7. content hardenings — `scripts/ci/package-content-validator.sh` (symlinks / submodules / LFS / size cap)
8. `classes/transforms/*.ts` type-check (if present)
9. capability declarations — `scripts/ci/check-package-capabilities.js` with `libs/runtime-api/`: every class under `classes/`, both call forms, the same reading as install (re-vendor the two together)
10. release coverage — `scripts/ci/coverage-gate.js`

`capability-gate` defaults to `fail` and `coverage-gate` to `warn`; a package
repo can pass either input to its call. A run stops after 15 minutes.

Once those pass, a second job in `release.yml` calls `package-publish.yml`, which
publishes the GitHub Release for the tag. It is a separate workflow because a
package repo's token is read-only by default and a called workflow cannot ask for
more than its caller granted, so `package-release.yml` stays read-only and this
job alone holds `contents: write`. It checks nothing out and runs only `gh`.

## Contents (vendored from `The-Freak-Geeks/xdeck`)

Every file here except this README is a copy of the file at the same path in
`The-Freak-Geeks/xdeck`; this README is kept there as `tools/release-host/README.md`.
The list itself lives in `scripts/ci/release-host-vendor.js` there:

| Path                                           | What it is                                                                                          |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `.github/workflows/package-publish.yml`        | publishes the GitHub Release for a tag that passed                                                  |
| `.github/workflows/package-release.yml`        | the reusable release workflow                                                                       |
| `libs/shared-types/src/package.schema.json`    | the package manifest schema                                                                         |
| `libs/shared-types/src/entity-dsl.schema.json` | the entity schema                                                                                   |
| `scripts/lint-engagement-subject.js`           | the privacy lint                                                                                    |
| `scripts/lint-package-sharing-roles.js`        | the sharing-rule lint                                                                               |
| `scripts/ci/package-content-validator.sh`      | the content hardenings                                                                              |
| `scripts/ci/check-package-capabilities.js`     | the capability check                                                                                |
| `scripts/ci/coverage-gate.js`                  | the release coverage gate                                                                           |
| `libs/runtime-api/`                            | the capability catalogue and static analyzer the check loads (standalone, no monorepo dependencies) |

> **Keeping it current.** A package tag is judged by what THIS repo holds, so a
> schema, validator or analyzer change in the monorepo reaches package releases
> only once it is copied here. A push to the monorepo's `master` compares this
> repo with the list and, on drift, opens or updates one pull request from the
> `release-host-sync` branch, which someone merges here. By hand, in the monorepo,
> `node scripts/ci/release-host-vendor.js` reports whether this repo holds exactly
> the list (exit 1 on drift), and `--out CLONE --prune` writes the list into a
> clone of this repo, to be merged here by pull request.

## Visibility

**Public.** The content is non-sensitive (the package schema's own `$id` is a
public URL; the validators and the capability catalogue are developer contract,
not business logic). Public lets package-repo workflows check this repo out with
the default `GITHUB_TOKEN` — no PAT or org secret needed. Flip to private plus a
fine-grained `xdeck-checkout-token` org secret if you prefer.
