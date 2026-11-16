#!/usr/bin/env node
/**
 * tools/deck-cli/validate.js — validate a deck's `config.json` against the platform's published
 * JSON Schemas. One copy, the platform's: a deck repository carries no tooling of its own. Its CI
 * runs this file from the public release host (`.github/workflows/deck-validate.yml`), and a person
 * runs it from a clone of the platform or of the host.
 *
 * **What this validates.** The consolidated deck config at the deck's root, `config.json`, has
 * top-level `config.<section>` sub-blocks. Each block has its own schema in `libs/shared-types` and
 * is registered in `SECTION_VALIDATORS` below. The validator projects each registered path out of
 * config.json and runs the matching schema through AJV.
 *
 * Slice 4 (§9.49) wires `config.observability.logging` against `OBSERVABILITY_CONFIG_SCHEMA`.
 * Future slices extend the registry by adding one row — no new code paths.
 *
 * **Schema source.** `require('@xdeck/shared-types')` wherever it resolves (the platform repo);
 * otherwise the copy in `schemas/` beside this file, which the platform's tenant-skeleton gate spec
 * holds equal to the export — the same JSON the backend's `withObservabilityConfigDefaults`
 * consumes, so the CI gate and the runtime cannot drift. Each run names the source it used.
 *
 * Usage:
 *   node tools/deck-cli/validate.js [--deck DIR]      # DIR defaults to the current directory
 *   npm run deck:validate -- --deck DIR               # the same, from the platform repo
 *
 * Exit:  0 valid (or no overrides declared) · 1 invalid · 2 hard error
 *        (config.json missing, parse failure, ajv missing, bad arguments)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { deckDir } = require('./deck-dir');

function die(msg, code = 2) {
  process.stderr.write(`validate: ${msg}\n`);
  process.exit(code);
}

// ── Load AJV + the schema ───────────────────────────────────────────
// Resolved from THIS file's folder, never from the deck: on the release host the reusable workflow
// installs `ajv` and `ajv-formats` from tools/deck-cli/package-lock.json, and in the platform repo
// they come from the root node_modules. A deck's own dependencies play no part.
let Ajv;
try {
  Ajv = require('ajv');
} catch (_) {
  die('ajv is not installed — run `npm ci` in tools/deck-cli', 2);
}
// ajv 8 checks no `format` (the schema's `uri`) without ajv-formats — it would pass a bad endpoint in
// silence — so with ajv 8 it is required. ajv 6 (the platform repo's) carries its own formats and
// takes no plugin.
let addFormats = null;
if (Number(require('ajv/package.json').version.split('.')[0]) >= 7) {
  try {
    addFormats = require('ajv-formats');
  } catch (_) {
    die('ajv-formats is not installed — run `npm ci` in tools/deck-cli', 2);
  }
}

// `@xdeck/shared-types` is the source of truth wherever it resolves (the platform repo); everywhere
// else the copy in schemas/, which the platform's tenant-skeleton gate spec keeps equal to it.
let shared = null;
try {
  shared = require('@xdeck/shared-types');
} catch (_) {
  shared = null;
}
const SCHEMA_SOURCE = shared ? '@xdeck/shared-types' : 'tools/deck-cli/schemas (a copy of @xdeck/shared-types)';
const OBSERVABILITY_CONFIG_SCHEMA = shared
  ? shared.OBSERVABILITY_CONFIG_SCHEMA
  : require('./schemas/observability-logging.schema.json');

// ── Section validator registry ──────────────────────────────────────
// Each entry projects a nested path out of config.json and validates
// the resolved block against its JSON Schema. `optional: true` means
// "absent block is fine; runtime falls back to schema defaults".
//
// Adding a new section schema is a one-line registry change.
const SECTION_VALIDATORS = [
  {
    path: ['config', 'observability', 'logging'],
    schema: OBSERVABILITY_CONFIG_SCHEMA,
    label: 'config.observability.logging',
    optional: true
  }
];

// ── Helpers ─────────────────────────────────────────────────────────
function projectPath(obj, segments) {
  let cur = obj;
  for (const seg of segments) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = cur[seg];
  }
  return cur;
}

function readTenantConfig(dir) {
  const configPath = path.join(dir, 'config.json');
  if (!fs.existsSync(configPath)) die(`config.json not found in ${dir}`, 2);
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (err) {
    die(`config.json read failed: ${err.message}`, 2);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    die(`config.json parse failed: ${err.message}`, 2);
  }
  return null;
}

function parseArgs(argv) {
  const opts = { deck: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      process.stdout.write(
        'Usage: node tools/deck-cli/validate.js [--deck DIR]   (DIR defaults to the current directory)\n'
      );
      process.exit(0);
    }
    if (a === '--deck') {
      if (i + 1 >= argv.length || argv[i + 1] === '') die('--deck requires a value', 2);
      opts.deck = argv[++i];
      continue;
    }
    die(`unknown flag: ${a}`, 2);
  }
  return opts;
}

// ── Main ────────────────────────────────────────────────────────────
function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dir = deckDir(opts.deck);
  process.stdout.write(
    `🔍 Validating config.json against ${SECTION_VALIDATORS.length} registered schema(s) from ${SCHEMA_SOURCE}...\n`
  );

  const config = readTenantConfig(dir);
  const ajv = new Ajv({ allErrors: true, strict: false });
  if (addFormats) addFormats(ajv);

  let errors = 0;
  let checked = 0;
  let skipped = 0;

  for (const entry of SECTION_VALIDATORS) {
    const value = projectPath(config, entry.path);
    if (value === undefined) {
      if (entry.optional) {
        skipped++;
        process.stdout.write(`ℹ️  ${entry.label} — no override declared (runtime uses schema defaults)\n`);
      } else {
        errors++;
        process.stdout.write(`❌ ${entry.label} — required block missing\n`);
      }
      continue;
    }
    const validate = ajv.compile(entry.schema);
    if (!validate(value)) {
      errors++;
      process.stdout.write(`❌ ${entry.label} — schema validation failed\n`);
      for (const err of validate.errors || []) {
        const at = err.instancePath || err.dataPath || '/'; // ajv 8 · ajv 6
        process.stdout.write(`   ${at} ${err.message}\n`);
      }
    } else {
      checked++;
      process.stdout.write(`✅ ${entry.label}\n`);
    }
  }

  if (errors > 0) {
    process.stdout.write(`❌ Validation failed — ${errors} error(s) (checked ${checked}, skipped ${skipped}).\n`);
    process.exit(1);
  }
  if (checked === 0) {
    process.stdout.write(
      `✅ No overrides declared — runtime will use schema defaults for all ${skipped} section(s).\n`
    );
    process.exit(0);
  }
  process.stdout.write(`✅ All ${checked} section(s) valid (skipped ${skipped} — using runtime defaults).\n`);
}

main();
