#!/usr/bin/env node
/**
 * §9.50 Phase B Slice 7 — CI driver for the capability-mismatch gate.
 *
 * Walks `<packageDir>/classes/transforms/` with the SAME analyzer the
 * install-time validator uses (`@xdeck/runtime-api/static-analyzer`),
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
 * Exit:
 *   0  — no findings (or `classes/transforms/` absent)
 *   1  — at least one undeclared / unresolvable finding
 *   2  — hard error (package.json missing/parse, analyzer not built)
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
    if (fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, 'tenants'))) return dir;
    dir = path.dirname(dir);
  }
  return null;
}

function loadAnalyzer(monorepoRoot) {
  const directPath = path.join(monorepoRoot, 'node_modules', '@xdeck', 'runtime-api', 'dist', 'static-analyzer.js');
  try {
    // Prefer the explicit dist file — survives node-classic resolution
    // + works regardless of the `exports` subpath map.
    if (fs.existsSync(directPath)) return require(directPath);
  } catch (_err) {
    /* fall through */
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
    die(`@xdeck/runtime-api/static-analyzer not resolvable — run \`npm install\` + \`(cd libs/runtime-api && npm run build)\` first`, 2);
  }
}

function readPackageManifest(packageDir) {
  const manifestPath = path.join(packageDir, 'package.json');
  if (!fs.existsSync(manifestPath)) die(`${path.relative(process.cwd(), manifestPath)} not found`, 2);
  let raw;
  try {
    raw = fs.readFileSync(manifestPath, 'utf8');
  } catch (err) {
    die(`${manifestPath} read failed: ${err.message}`, 2);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    die(`${manifestPath} parse failed: ${err.message}`, 2);
  }
  return null;
}

function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write('Usage: node check-package-capabilities.js <packageDir>\n');
    process.exit(0);
  }
  const positional = argv.filter((a) => !a.startsWith('-'));
  if (positional.length > 1) die(`expected at most one positional <packageDir>, got ${positional.length}`, 2);
  return { packageDir: path.resolve(positional[0] || 'pkg') };
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

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const monorepoRoot = findMonorepoRoot(__dirname);
  if (!monorepoRoot) die(`could not locate monorepo root from ${__dirname}`, 2);
  const analyzer = loadAnalyzer(monorepoRoot);

  const manifest = readPackageManifest(opts.packageDir);
  const caps = (manifest && manifest.capabilities) || {};
  const required = Array.isArray(caps.required) ? caps.required : [];
  const optional = Array.isArray(caps.optional) ? caps.optional : [];
  const declared = new Set([...required, ...optional]);

  process.stdout.write(`🔍 Static capability analysis — ${path.relative(process.cwd(), opts.packageDir) || '.'}\n`);
  const analysis = analyzer.analyzePackageDir(opts.packageDir, {
    onWarn: (msg) => process.stderr.write(`analyzer: ${msg}\n`)
  });

  if (analysis.used.length === 0 && analysis.unresolvable.length === 0) {
    process.stdout.write('ℹ️  No xdeck.* calls found (or no classes/transforms/ directory) — nothing to gate.\n');
    writeStepSummary([
      '## Capability validation',
      '',
      'ℹ️ No `xdeck.*` calls found (or no `classes/transforms/` directory). Nothing to gate.'
    ]);
    process.exit(0);
  }

  const undeclared = analysis.used.filter((u) => !declared.has(u.capability));
  const unresolvable = analysis.unresolvable;

  if (undeclared.length === 0 && unresolvable.length === 0) {
    process.stdout.write(`✅ All ${analysis.used.length} capability use(s) declared in manifest.\n`);
    writeStepSummary([
      '## Capability validation',
      '',
      `✅ All ${analysis.used.length} capability use(s) declared in manifest.`,
      '',
      '| Capability | Call sites |',
      '| --- | --- |',
      ...analysis.used.map((u) => `| \`${u.capability}\` | ${u.callSites.length} |`)
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

  writeStepSummary(summaryLines);
  process.exit(1);
}

main();
