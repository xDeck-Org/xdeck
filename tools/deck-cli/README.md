# tools/deck-cli — the deck verbs

One copy of the deck tooling, the platform's. A deck repository carries none: its workflows call the
platform's reusable workflows on the public release host, which run these files.

| Verb                  | What it does                                                                                    | Exit                                     |
| --------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `validate.js`         | Validates the deck's `config.json` against the platform's schemas                               | 0 valid · 1 invalid · 2 could not judge  |
| `deploy.js`           | Validates, then sends the deck's config, entities and triggers to an env's `/internal` endpoint | 0 deployed · 1 refused or failed         |
| `release.js`          | Cuts an annotated `<slug>/vX.Y.Z` tag on the deck's `master` and pushes it                      | 0 tagged (or dry run) · 1 refused/failed |
| `register-release.js` | Registers a validated tag in the platform's release registry (`POST /internal/releases`)        | 0 registered · 1 refused or failed       |

`ci-credential.js` is no verb: it is how `deploy.js` and `register-release.js` choose the bearer they send.

Every verb takes `--deck DIR`; without it, the current directory is the deck. The deck's slug is the
`subdomain` in its `config.json`, or the folder's name when `config.json` names none.

## Run it on your machine

From a clone of the platform (or of the release host, after `npm ci` in `tools/deck-cli`):

```bash
npm run deck:validate -- --deck ../xdeck-tenants/xdeck-tenant-SLUG
DEPLOY_API_URL=https://api.example.com DEPLOY_API_KEY=KEY \
  npm run deck:deploy -- --deck ../xdeck-tenants/xdeck-tenant-SLUG --env dev1 --dry-run
npm run deck:release -- --deck ../xdeck-tenants/xdeck-tenant-SLUG --bump patch --dry-run
```

`release.js` runs every git command in the deck's repository, never in the directory you started from.

## The credential

`deploy.js` and `register-release.js` send one bearer, chosen in this order:

1. **The platform key**, when its variable is set (`DEPLOY_API_KEY` for `deploy.js`, `REGISTRY_API_KEY`
   for `register-release.js`): platform automation, or a person at a terminal. A set key always wins.
2. **The deck's own GitHub OIDC token**, inside a GitHub Actions job granted `id-token: write`
   (`ACTIONS_ID_TOKEN_REQUEST_URL` and `ACTIONS_ID_TOKEN_REQUEST_TOKEN` set): minted for the audience
   `SLUG.deploy.xdeck.in`. The platform admits it only for that deck — the token's repository id must be
   the deck's linked repository, its workflow `deck-deploy.yml` / `deck-validate.yml` on the release host
   at `main` or a tag, and, for a deploy, its GitHub Environment the env being deployed (never
   production). This is what a deck repository's CI uses: it holds no key.
3. Neither → exit 1, naming both.

The token is never printed.

## In a deck repository's CI

| Deck workflow         | Calls                                                                 | Runs                                            |
| --------------------- | --------------------------------------------------------------------- | ----------------------------------------------- |
| `validate-on-pr.yml`  | `xdeck-org/xdeck/.github/workflows/deck-validate.yml@main`            | `validate.js`                                   |
| `validate-on-tag.yml` | the same, with `release-tag: true`                                    | tag check, `validate.js`, `register-release.js` |
| `branch-deploy.yml`   | `xdeck-org/xdeck/.github/workflows/deck-deploy.yml@main` (env branch) | `validate.js`, then `deploy.js`                 |

There is no release workflow: a release is the local verb above, and `validate-on-tag.yml` judges every tag.
A production deploy is started from the platform UI on a registered tag.

Each calling job grants `permissions: contents: read, id-token: write` and passes no secret. A deck
repository needs only the variables `DEPLOY_API_URL` (per env-branch Environment) and
`REGISTRY_API_URL` (repository), and a linked repository on the platform.

The reusable workflows install only what `package-lock.json` here pins (ajv 8 and ajv-formats), with
no install scripts. Where `@xdeck/shared-types` resolves (the platform repo) the schemas come from it;
on the host they come from `schemas/`, which the tenant-skeleton gate spec holds equal to it.

## Changing it

- Edit here, in the platform. `scripts/ci/release-host-vendor.js` (`DECK_CLI`) lists every file the host
  must hold, and `release-host-sync.yml` opens the host's sync pull request; deck repositories pick a
  change up once that pull request is merged.
- `npm run deck-cli:test` runs the tests; the tenant-skeleton gate spec runs them too.
- The host is public: no secret, internal hostname or deck name belongs in any file here.
