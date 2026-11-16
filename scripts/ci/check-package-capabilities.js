#!/usr/bin/env node
/**
 * §9.50 Phase B Slice 7 — CI driver for the capability-mismatch gate.
 *
 * Walks every class under `<packageDir>/classes/` with the SAME analyzer
 * the install-time validator uses (`@xdeck/runtime-api/static-analyzer`),
 * cross-checks the result against `<packageDir>/package.json`'s
 * `capabilities.{required,optional}` declarations, and exits 1 on
 * any `PACKAGE_CAPABILITY_UNDECLARED` / `PACKAGE_CAPABILITY_USAGE_UNRESOLVABLE`
 * finding. Writes a structured `## Capability validation` block to
 * `$GITHUB_STEP_SUMMARY` so package authors see the offender file +
 * line + capability + remediation right in the workflow run.
 *
 * Identical issue codes to install-time (single vocabulary across CI
 * + install paths). Set-difference matches `PackageValidatorService.
 * validateCapabilityUsage()` exactly.
 *
 * Usage:
 *   node scripts/ci/check-package-capabilities.js <packageDir>
 * <packageDir> defaults to `./pkg` (the path the reusable workflow
 * checks the candidate repo into).
 *
 *   --fleet [DIR]     check every `xdeck-pkg-*` repo under DIR (default
 *                     $PACKAGES_SIBLING_ROOT, else ../xdeck-packages) —
 *                     `npm run packages:lint-capabilities` runs it before
 *                     any sibling ship.
 * There is one reading (the analyzer's module doc): the release workflow, the
 * fleet gate and install-time validation judge a package the same way. A
 * computed resource id passes only with a reasoned `xdeck-capability-dynamic:`
 * marker, and is listed — on stdout and in the step summary.
 *
 * Exit:
 *   0  — no findings (or the scanned directory absent)
 *   1  — at least one undeclared / unresolvable finding
 *   2  — hard error (package.json missing/parse, analyzer not built, an
 *        unknown flag, or a fleet with no package in it — nothing checked
 *        is not a pass)
 */
'use strict';

const fs = require('fs');
const path = require('path');

function die(msg, code = 2) {
  process.stderr.write(`check-package-capabilities: ${msg}\n`);
  process.exit(code);
}

function findMonorepoRoot(startDir) {
  let dir = startDir;
  while (dir !== path.dirname(dir)) {
    // libs/runtime-api exists in both the full monorepo and the vendored release
    // hub (xdeck-org/xdeck); tenants/ is monorepo-only (the hub mirror omits it),
    // so keying off it broke the gate when this script runs on the hub.
    if (fs.existsSync(path.join(dir, 'libs', 'runtime-api'))) return dir;
    dir = path.dirname(dir);
  }
  return null;
}

function loadAnalyzer(monorepoRoot) {
  // Resolve the analyzer in both layouts: the full monorepo installs it under
  // node_modules/@xdeck; the vendored release hub builds it in place at
  // libs/runtime-api/dist (no root node_modules symlink).
  const directPaths = [
    path.join(monorepoRoot, 'node_modules', '@xdeck', 'runtime-api', 'dist', 'static-analyzer.js'),
    path.join(monorepoRoot, 'libs', 'runtime-api', 'dist', 'static-analyzer.js')
  ];
  for (const directPath of directPaths) {
    try {
      // Prefer the explicit dist file — survives node-classic resolution
      // + works regardless of the `exports` subpath map.
      if (fs.existsSync(directPath)) return require(directPath);
    } catch (_err) {
      /* fall through */
    }
  }
  try {
    return require('@xdeck/runtime-api/static-analyzer');
  } catch (_err) {
    /* fall through */
  }
  try {
    // Last resort — bare import resolves via the index re-export.
    return require('@xdeck/runtime-api');
  } catch (_err) {
    die(
      `@xdeck/runtime-api/static-analyzer not resolvable — run \`npm install\` + \`(cd libs/runtime-api && npm run build)\` first`,
      2
    );
  }
}

/** `{ manifest }` or `{ error }` — never exits, so the fleet walk can report and go on. */
function loadManifest(packageDir) {
  const manifestPath = path.join(packageDir, 'package.json');
  if (!fs.existsSync(manifestPath)) return { error: `${path.relative(process.cwd(), manifestPath)} not found` };
  let raw;
  try {
    raw = fs.readFileSync(manifestPath, 'utf8');
  } catch (err) {
    return { error: `${manifestPath} read failed: ${err.message}` };
  }
  try {
    return { manifest: JSON.parse(raw) };
  } catch (err) {
    return { error: `${manifestPath} parse failed: ${err.message}` };
  }
}

function readPackageManifest(packageDir) {
  const loaded = loadManifest(packageDir);
  if (loaded.error) die(loaded.error, 2);
  return loaded.manifest;
}

/** The analysis plus its set-difference against the manifest — the install-time vocabulary. */
function checkPackage(analyzer, packageDir, manifest) {
  const caps = (manifest && manifest.capabilities) || {};
  const required = Array.isArray(caps.required) ? caps.required : [];
  const optional = Array.isArray(caps.optional) ? caps.optional : [];
  const declared = new Set([...required, ...optional]);
  const analysis = analyzer.analyzePackageDir(packageDir, {
    onWarn: (msg) => process.stderr.write(`analyzer: ${msg}\n`)
  });
  return {
    analysis,
    undeclared: analysis.used.filter((u) => !declared.has(u.capability)),
    unresolvable: analysis.unresolvable,
    acknowledged: analysis.acknowledged || []
  };
}

const KNOWN_FLAGS = new Set(['--fleet']);

function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write('Usage: node check-package-capabilities.js [--fleet] [<packageDir> | <fleetDir>]\n');
    process.exit(0);
  }
  const unknown = argv.filter((a) => a.startsWith('-') && !KNOWN_FLAGS.has(a));
  if (unknown.length > 0) die(`unknown flag(s): ${unknown.join(' ')}`, 2);
  const positional = argv.filter((a) => !a.startsWith('-'));
  if (positional.length > 1) die(`expected at most one positional <packageDir>, got ${positional.length}`, 2);
  const fleet = argv.includes('--fleet');
  return {
    fleet,
    packageDir: fleet ? null : path.resolve(positional[0] || 'pkg'),
    fleetDir: fleet ? positional[0] || process.env.PACKAGES_SIBLING_ROOT || null : null
  };
}

function writeStepSummary(lines) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  try {
    fs.appendFileSync(summaryPath, lines.join('\n') + '\n');
  } catch (err) {
    process.stderr.write(`could not append to GITHUB_STEP_SUMMARY: ${err.message}\n`);
  }
}

/** Every `xdeck-pkg-*` repo under the fleet directory, one line each; exits 0 / 1 / 2. */
function mainFleet(analyzer, monorepoRoot, opts) {
  const fleetDir = path.resolve(opts.fleetDir || path.join(monorepoRoot, '..', 'xdeck-packages'));
  if (!fs.existsSync(fleetDir)) die(`fleet directory ${fleetDir} not found — pass it, or set PACKAGES_SIBLING_ROOT`, 2);
  const repos = fs
    .readdirSync(fleetDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('xdeck-pkg-'))
    .map((e) => e.name)
    .sort();
  if (repos.length === 0)
    die(`no xdeck-pkg-* directory under ${fleetDir} — nothing was checked, which is not a pass`, 2);

  process.stdout.write(`🔍 Static capability analysis — ${repos.length} packages under ${fleetDir}\n`);
  let failing = 0;
  let unreadable = 0;
  const acknowledged = [];
  for (const repo of repos) {
    const dir = path.join(fleetDir, repo);
    const label = repo.replace(/^xdeck-pkg-/, '').padEnd(22);
    const loaded = loadManifest(dir);
    if (loaded.error) {
      unreadable += 1;
      process.stdout.write(`  ⛔ ${label} ${loaded.error}\n`);
      continue;
    }
    const r = checkPackage(analyzer, dir, loaded.manifest);
    const undeclaredSites = r.undeclared.reduce((n, f) => n + f.callSites.length, 0);
    const ack = r.acknowledged.length > 0 ? ` · ${r.acknowledged.length} dynamic, acknowledged` : '';
    if (undeclaredSites === 0 && r.unresolvable.length === 0) {
      process.stdout.write(`  ✅ ${label} ${r.analysis.used.length} capability use(s), all declared${ack}\n`);
    } else {
      failing += 1;
      process.stdout.write(
        `  ❌ ${label} ${undeclaredSites} undeclared · ${r.unresolvable.length} unresolvable${ack}\n`
      );
      for (const finding of r.undeclared) {
        for (const site of finding.callSites) {
          process.stdout.write(`       ${site.file}:${site.line}  needs \`${finding.capability}\`\n`);
        }
      }
      for (const u of r.unresolvable) process.stdout.write(`       ${u.file}:${u.line}  ${u.reason}\n`);
    }
    for (const a of r.acknowledged)
      acknowledged.push(`${repo.replace(/^xdeck-pkg-/, '')} ${a.file}:${a.line} — ${a.note}`);
  }
  if (acknowledged.length > 0) {
    process.stdout.write(
      `ℹ️  ${acknowledged.length} computed resource id(s) carry a dynamic marker; the platform still refuses each one without a grant:\n`
    );
    for (const line of acknowledged) process.stdout.write(`   ${line}\n`);
  }
  process.stdout.write(`Result: ${repos.length} packages · ${failing} failing · ${unreadable} unreadable\n`);
  process.exit(unreadable > 0 ? 2 : failing > 0 ? 1 : 0);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const monorepoRoot = findMonorepoRoot(__dirname);
  if (!monorepoRoot) die(`could not locate monorepo root from ${__dirname}`, 2);
  const analyzer = loadAnalyzer(monorepoRoot);
  if (opts.fleet) return mainFleet(analyzer, monorepoRoot, opts);

  const manifest = readPackageManifest(opts.packageDir);

  process.stdout.write(`🔍 Static capability analysis — ${path.relative(process.cwd(), opts.packageDir) || '.'}\n`);
  const { analysis, undeclared, unresolvable, acknowledged } = checkPackage(analyzer, opts.packageDir, manifest);
  for (const a of acknowledged) {
    process.stdout.write(`ℹ️  ${a.file}:${a.line}  computed resource id, marked dynamic — ${a.note}\n`);
  }
  const acknowledgedLines = acknowledgedSummary(acknowledged);

  if (analysis.used.length === 0 && unresolvable.length === 0 && acknowledged.length === 0) {
    process.stdout.write('ℹ️  No xdeck calls found (or no classes/ directory) — nothing to gate.\n');
    writeStepSummary([
      '## Capability validation',
      '',
      'ℹ️ No `xdeck` calls found (or no `classes/` directory). Nothing to gate.'
    ]);
    process.exit(0);
  }

  if (undeclared.length === 0 && unresolvable.length === 0) {
    process.stdout.write(`✅ All ${analysis.used.length} capability use(s) declared in manifest.\n`);
    writeStepSummary([
      '## Capability validation',
      '',
      `✅ All ${analysis.used.length} capability use(s) declared in manifest.`,
      '',
      '| Capability | Call sites |',
      '| --- | --- |',
      ...analysis.used.map((u) => `| \`${u.capability}\` | ${u.callSites.length} |`),
      ...acknowledgedLines
    ]);
    process.exit(0);
  }

  // ── Failures ────────────────────────────────────────────────────────
  const summaryLines = ['## Capability validation', ''];

  if (undeclared.length > 0) {
    process.stdout.write(`❌ ${undeclared.length} undeclared capability use(s):\n`);
    summaryLines.push(`### ❌ \`PACKAGE_CAPABILITY_UNDECLARED\` × ${undeclared.length}`);
    summaryLines.push('');
    summaryLines.push('| Capability | File | Line | Fix |');
    summaryLines.push('| --- | --- | --- | --- |');
    for (const finding of undeclared) {
      for (const site of finding.callSites) {
        process.stdout.write(`   ${site.file}:${site.line}  needs \`${finding.capability}\`\n`);
        summaryLines.push(
          `| \`${finding.capability}\` | \`${site.file}\` | ${site.line} | Add to \`package.json\` → \`capabilities.required\` |`
        );
      }
    }
    summaryLines.push('');
  }

  if (unresolvable.length > 0) {
    process.stdout.write(`❌ ${unresolvable.length} unresolvable capability call site(s):\n`);
    summaryLines.push(`### ❌ \`PACKAGE_CAPABILITY_USAGE_UNRESOLVABLE\` × ${unresolvable.length}`);
    summaryLines.push('');
    summaryLines.push('| File | Line | Expression | Reason |');
    summaryLines.push('| --- | --- | --- | --- |');
    for (const u of unresolvable) {
      process.stdout.write(`   ${u.file}:${u.line}  ${u.reason}\n`);
      const expr = u.expression.replace(/\|/g, '\\|');
      const reason = u.reason.replace(/\|/g, '\\|');
      summaryLines.push(`| \`${u.file}\` | ${u.line} | \`${expr}\` | ${reason} |`);
    }
    summaryLines.push('');
  }

  writeStepSummary([...summaryLines, ...acknowledgedLines]);
  process.exit(1);
}

/** Step-summary rows for marked computed resource ids: never counted as declared, never hidden. */
function acknowledgedSummary(acknowledged) {
  if (acknowledged.length === 0) return [];
  return [
    '',
    `### ℹ️ Computed resource ids, marked dynamic × ${acknowledged.length}`,
    '',
    'The platform refuses each read without a grant; the marker only records why the id is computed.',
    '',
    '| File | Line | Expression | Why |',
    '| --- | --- | --- | --- |',
    ...acknowledged.map(
      (a) =>
        `| \`${a.file}\` | ${a.line} | \`${a.expression.replace(/\|/g, '\\|')}\` | ${a.note.replace(/\|/g, '\\|')} |`
    )
  ];
}

if (require.main === module) main();
