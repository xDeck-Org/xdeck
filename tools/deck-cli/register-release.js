#!/usr/bin/env node
/**
 * tools/deck-cli/register-release.js — register a validated release tag of a deck in the platform's
 * release registry (POST /internal/releases). It never deploys: a production deploy is started from
 * the platform UI on a registered tag (§9.46.5).
 *
 * Run by the release host's `.github/workflows/deck-validate.yml` (`release-tag: true`) once the
 * tagged commit validates; a person can run it too.
 *
 * Usage:
 *   node tools/deck-cli/register-release.js --slug SLUG --tag TAG --version vX.Y.Z \
 *     --commit-sha SHA --validated-by WHO
 *
 * Env:
 *   REGISTRY_API_URL — the base URL of the platform API (required)
 *   REGISTRY_API_KEY — the platform key (optional). Without it, inside a GitHub Actions job granted
 *                      `id-token: write`, the deck's own OIDC token is sent (ci-credential.js) — the
 *                      platform then records the token's verified repository and commit, not the
 *                      `--commit-sha` / `--validated-by` given here.
 *
 * Exit: 0 registered (or already registered) · 1 refused, or a bad argument.
 */
'use strict';

const { SLUG_RE } = require('./deck-dir');
const { credentialSource, missingCredentialMessage, resolveBearer } = require('./ci-credential');

const KEY_ENV = 'REGISTRY_API_KEY';
const VERSION_RE = /^v[0-9]+\.[0-9]+\.[0-9]+$/;

function die(msg, code = 1) {
  process.stderr.write(`❌ ${msg}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const opts = { slug: '', tag: '', version: '', commitSha: '', validatedBy: '' };
  const flags = {
    '--slug': 'slug',
    '--tag': 'tag',
    '--version': 'version',
    '--commit-sha': 'commitSha',
    '--validated-by': 'validatedBy'
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      process.stdout.write('See JSDoc header at top of this file.\n');
      process.exit(0);
    }
    if (!Object.prototype.hasOwnProperty.call(flags, a)) die(`Unknown argument: ${a}`);
    if (i + 1 >= argv.length) die(`${a} requires a value`);
    opts[flags[a]] = argv[++i];
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  // The slug becomes the audience of the deck's token and names the deck in the body: never one that is not a slug.
  if (!SLUG_RE.test(opts.slug)) die(`Invalid --slug: ${opts.slug} (lowercase alphanumeric + hyphens, 1-50 chars)`);
  if (!VERSION_RE.test(opts.version)) die(`Invalid --version: ${opts.version} (expected vX.Y.Z)`);
  if (opts.tag !== opts.version && opts.tag !== `${opts.slug}/${opts.version}`) {
    die(`--tag ${opts.tag} is neither ${opts.version} nor ${opts.slug}/${opts.version}`);
  }
  if (!opts.commitSha || !opts.validatedBy) die('--commit-sha and --validated-by are required');

  const apiUrl = process.env.REGISTRY_API_URL;
  if (!apiUrl) die('REGISTRY_API_URL must be set (the platform API base URL)');
  if (credentialSource(process.env, KEY_ENV) === null) die(missingCredentialMessage(KEY_ENV));

  let credential;
  try {
    credential = await resolveBearer({ slug: opts.slug, keyEnv: KEY_ENV });
  } catch (err) {
    die(err.message || String(err));
  }

  const endpoint = `${apiUrl.replace(/\/+$/, '')}/internal/releases`;
  process.stdout.write(`📝 Registering ${opts.tag} (${opts.slug} ${opts.version}) → ${endpoint}\n`);
  process.stdout.write(`   credential: ${credential.kind === 'key' ? KEY_ENV : 'GitHub OIDC token for this deck'}\n`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  let res, text;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${credential.bearer}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'tenant',
        slug: opts.slug,
        tag: opts.tag,
        version: opts.version,
        commitSha: opts.commitSha,
        validatedBy: opts.validatedBy
      }),
      signal: controller.signal
    });
    text = await res.text();
  } catch (err) {
    die(`Registration request failed: ${err.message || err}`);
  } finally {
    clearTimeout(timeout);
  }

  process.stdout.write(`HTTP ${res.status}\n${text}\n`);
  if (!res.ok) die(`Registration refused (HTTP ${res.status})`);
  process.stdout.write(`✅ Registered ${opts.tag} (${opts.slug} ${opts.version}) in the xDeck release registry.\n`);
}

main().catch((err) => die(err.message || String(err)));
