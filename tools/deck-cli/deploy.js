#!/usr/bin/env node
/**
 * tools/deck-cli/deploy.js — sync a deck's content to an xDeck environment via HTTP. The platform's
 * one copy: a deck repository's env-branch CI runs it from the public release host
 * (`.github/workflows/deck-deploy.yml`), and a person runs it from a clone of the platform.
 *
 * The deck is `--deck DIR` (default: the current directory); its slug is config.json's `subdomain`,
 * or the folder's name when config.json names none (deck-dir.js). Reads the deck's files from DIR,
 * packages them into the request body, and POSTs to the NestJS /internal deploy endpoint.
 *
 * Usage:
 *   node tools/deck-cli/deploy.js [--deck DIR]
 *   node tools/deck-cli/deploy.js --deck DIR --version v1.2.3 --env dev
 *   node tools/deck-cli/deploy.js --deck DIR --tag SLUG.dev/v1.2.3
 *   node tools/deck-cli/deploy.js --deck DIR --type config
 *   node tools/deck-cli/deploy.js --deck DIR --dry-run
 *   npm run deck:deploy -- --deck DIR ...                   # the same, from the platform repo
 *
 * Release-metadata flags (recorded in tenant_release_log audit table):
 *   --version vX.Y.Z        semver tag portion (required for non-dry-run CI)
 *   --env <env>             prod | dev | sit | uat | staging
 *   --tag <full-tag>        full git tag (e.g. SLUG.dev/v1.2.3); env/version derived
 *   --triggered-by <src>    push | dispatch | cli (default: cli)
 *   --commit-sha <sha>      git commit the tag pointed at
 *
 * Env (in CI, DEPLOY_API_URL comes from the deck's GitHub Environment named after the env branch):
 *   DEPLOY_API_URL — the API base URL of the target environment (required)
 *   DEPLOY_API_KEY — the platform key (optional; platform automation, a person). Without it, inside a
 *                    GitHub Actions job granted `id-token: write` (deck-deploy.yml), the deck's own
 *                    OIDC token is sent instead, minted for SLUG.deploy.xdeck.in (ci-credential.js):
 *                    a deck repository holds no key. Neither → exit 1, naming both.
 *
 * Cross-platform: Node-only. fetch (built-in 18+); spawnSync for validate.js.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { SLUG_RE, deckDir, deckSlug } = require('./deck-dir');
const { credentialSource, missingCredentialMessage, resolveBearer } = require('./ci-credential');

const KEY_ENV = 'DEPLOY_API_KEY';

function die(msg, code = 1) {
  process.stderr.write(`❌ ${msg}\n`);
  process.exit(code);
}

const TAG_RE = /^([a-z0-9][a-z0-9-]{0,49})(?:\.(dev|sit|uat|staging|prod))?\/(v[0-9]+\.[0-9]+\.[0-9]+)$/;

function parseArgs(argv) {
  const opts = {
    deck: undefined,
    deployType: 'all',
    dryRun: false,
    version: '',
    envName: '',
    tag: '',
    triggeredBy: 'cli',
    commitSha: ''
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) die(`${a} requires a value`, 1);
      return argv[++i];
    };
    switch (a) {
      case '--deck':
        opts.deck = next();
        break;
      case '--type':
        opts.deployType = next();
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--version':
        opts.version = next();
        break;
      case '--env':
        opts.envName = next();
        break;
      case '--tag':
        opts.tag = next();
        break;
      case '--triggered-by':
        opts.triggeredBy = next();
        break;
      case '--commit-sha':
        opts.commitSha = next();
        break;
      case '-h':
      case '--help':
        process.stdout.write('See JSDoc header at top of this file.\n');
        process.exit(0);
        break;
      default:
        die(`Unknown argument: ${a}`, 1);
    }
  }
  return opts;
}

function deriveFromTag(opts, slug) {
  if (!opts.tag) return;
  const m = opts.tag.match(TAG_RE);
  if (!m) die(`Invalid --tag format: ${opts.tag}\n   Expected: <slug>/vX.Y.Z  or  <slug>.<env>/vX.Y.Z`, 1);
  const tagSlug = m[1],
    tagEnv = m[2] || 'prod',
    tagVer = m[3];
  if (tagSlug !== slug) die(`tag slug mismatch: this tenant is "${slug}", tag refers to "${tagSlug}"`, 1);
  if (!opts.envName) opts.envName = tagEnv;
  if (!opts.version) opts.version = tagVer;
  if (opts.envName !== tagEnv) die(`env mismatch: --env=${opts.envName}, tag=${tagEnv}`, 1);
  if (opts.version !== tagVer) die(`version mismatch: --version=${opts.version}, tag=${tagVer}`, 1);
}

function readJsonDir(dir) {
  if (!fs.existsSync(dir)) return {};
  const out = {};
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    out[name.slice(0, -5)] = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
  }
  return out;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const TENANT_DIR = deckDir(opts.deck);
  if (!fs.existsSync(TENANT_DIR)) die(`tenant folder vanished: ${TENANT_DIR}`, 1);
  const SLUG = deckSlug(TENANT_DIR);
  // The slug becomes a path segment of the deploy URL: never one that could leave it.
  if (!SLUG_RE.test(SLUG)) die(`Invalid slug: ${SLUG} (lowercase alphanumeric + hyphens, 1-50 chars)`, 1);
  deriveFromTag(opts, SLUG);
  if (!opts.envName) opts.envName = 'dev';

  if (!process.env.DEPLOY_API_URL) die('DEPLOY_API_URL must be set (e.g. https://api.example.com)', 1);
  if (credentialSource(process.env, KEY_ENV) === null) die(missingCredentialMessage(KEY_ENV), 1);

  // Pre-flight schema validation — never deploy invalid files. Calls the
  // sibling validate.js so the validation logic stays single-sourced.
  process.stdout.write(`🔍 Validating ${SLUG}...\n`);
  const validate = spawnSync(process.execPath, [path.join(__dirname, 'validate.js'), '--deck', TENANT_DIR], {
    stdio: 'inherit'
  });
  if (validate.status !== 0) process.exit(validate.status || 1);

  process.stdout.write('\n');
  process.stdout.write(`🚀 Deploying ${SLUG} → ${process.env.DEPLOY_API_URL}\n`);
  process.stdout.write(`   env       : ${opts.envName}\n`);
  process.stdout.write(`   version   : ${opts.version || '<none>'}\n`);
  process.stdout.write(`   tag       : ${opts.tag || '<none>'}\n`);
  process.stdout.write(`   type      : ${opts.deployType}\n`);
  process.stdout.write(`   dry-run   : ${opts.dryRun}\n`);
  process.stdout.write(`   triggered : ${opts.triggeredBy}\n`);
  process.stdout.write(
    `   credential: ${credentialSource(process.env, KEY_ENV) === 'key' ? KEY_ENV : 'GitHub OIDC token for this deck'}\n`
  );
  process.stdout.write('\n');

  // ── Build payload ───────────────────────────────────────────────
  let configJson = {},
    entitiesJson = {},
    triggersJson = {};

  if (opts.deployType === 'config' || opts.deployType === 'all') {
    const cfgFile = path.join(TENANT_DIR, 'config.json');
    if (fs.existsSync(cfgFile)) {
      const raw = fs.readFileSync(cfgFile, 'utf8');
      configJson = JSON.parse(raw);
      process.stdout.write(`  📄 config.json read (${raw.length} bytes)\n`);
    } else {
      process.stdout.write('  ⚠️  config.json not found — skipping\n');
    }
  }
  if (opts.deployType === 'entities' || opts.deployType === 'all') {
    entitiesJson = readJsonDir(path.join(TENANT_DIR, 'entities'));
    process.stdout.write(`  📁 entities read (${Object.keys(entitiesJson).length} files)\n`);
  }
  if (opts.deployType === 'triggers' || opts.deployType === 'all') {
    triggersJson = readJsonDir(path.join(TENANT_DIR, 'triggers'));
    process.stdout.write(`  📁 triggers read (${Object.keys(triggersJson).length} files)\n`);
  }

  const release = {};
  if (opts.version) release.version = opts.version;
  if (opts.envName) release.environment = opts.envName;
  if (opts.tag) release.tag = opts.tag;
  if (opts.triggeredBy) release.triggeredBy = opts.triggeredBy;
  if (opts.commitSha) release.commitSha = opts.commitSha;

  const payload = {
    type: opts.deployType,
    dryRun: opts.dryRun,
    config: configJson,
    entities: entitiesJson,
    triggers: triggersJson,
    ...release
  };

  // ── POST ────────────────────────────────────────────────────────
  const endpoint = `${process.env.DEPLOY_API_URL.replace(/\/+$/, '')}/internal/tenants/${SLUG}/deploy`;
  process.stdout.write(`\n  → POST ${endpoint}\n\n`);

  // The key when one is set, else the deck's own OIDC token. Never printed.
  let credential;
  try {
    credential = await resolveBearer({ slug: SLUG, keyEnv: KEY_ENV });
  } catch (err) {
    die(err.message || String(err), 1);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  let res, body, parsed;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credential.bearer}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    body = await res.text();
  } catch (err) {
    die(`Deploy request failed: ${err.message || err}`, 1);
  } finally {
    clearTimeout(timeout);
  }

  process.stdout.write(`HTTP ${res.status}\n`);
  try {
    parsed = JSON.parse(body);
    process.stdout.write(JSON.stringify(parsed, null, 2) + '\n');
  } catch (_) {
    process.stdout.write(body + '\n');
  }

  if (!res.ok) die(`Deploy failed (HTTP ${res.status})`, 1);
  if (parsed && parsed.success !== true) {
    const errs = Array.isArray(parsed.errors) ? parsed.errors.join(', ') : '';
    die(`Deploy reported failure: ${errs}`, 1);
  }

  process.stdout.write('\n');
  if (opts.dryRun) {
    process.stdout.write(`✅ Dry run complete — ${SLUG} (no changes written)\n`);
  } else {
    const synced = Array.isArray(parsed?.synced) ? parsed.synced.join(', ') : '';
    const logId = parsed?.releaseLogId || '';
    process.stdout.write(`✅ Deployed ${SLUG} — synced: ${synced}\n`);
    if (logId) process.stdout.write(`   releaseLogId: ${logId}\n`);
  }
}

main().catch((err) => die(err.message || String(err), 1));
