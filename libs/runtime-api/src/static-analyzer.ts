/**
 * §9.50 Phase B Slice 7 — static-analysis capability validator (pure-Node).
 *
 * Walks the TypeScript source of a package's class transforms, extracts
 * every direct `xdeck.<domain>.<method>(...)` call, and reports the set
 * of capabilities the package USES. Consumers (install-time validator
 * in `apps/backend`, CI driver in `scripts/ci/`) cross-check against
 * `manifest.capabilities` to surface undeclared usage as
 * `PACKAGE_CAPABILITY_UNDECLARED` / unresolvable patterns as
 * `PACKAGE_CAPABILITY_USAGE_UNRESOLVABLE`.
 *
 * **Why static analysis on top of the runtime guard.** The guard rejects
 * any ungranted capability call at runtime — but ONLY for tenants who
 * happen to have grants for some OTHER capability for that package. A
 * package that declares no capabilities and silently calls
 * `xdeck.email.send(...)` would slip past the guard the moment a tenant
 * grants ANY capability. Install-time + CI static analysis close that
 * gap before tenants are ever exposed.
 *
 * **Coverage (Phase 1, this slice):**
 *  - Direct member-access calls: `xdeck.email.send(payload)`,
 *    `xdeck.notification.broadcast(payload)`, `xdeck.entity.read({...})`.
 *  - Parameterized resource extraction from literal-string args:
 *    `xdeck.entity.read({entityName: 'Patient'})` → `entity:read:Patient`.
 *  - `xdeck.context.<field>` — skipped (identity context, no capability).
 *  - Multi-file walks every `.ts` under `<packageDir>/classes/transforms/`.
 *  - Unresolvable usage (aliases, destructuring, non-literal resource
 *    args, partial member access like `xdeck.email`) is reported with
 *    a clear remediation message; the caller blocks install/publish.
 *
 * **Pure Node.** No `@nestjs/common`, no Nest `Logger`. The `onWarn`
 * option lets consumers route diagnostic messages (unreadable files,
 * unlistable directories) wherever they want — a Nest service wraps
 * this and pipes them to `Logger.warn`; the CI driver pipes them to
 * `console.warn`.
 *
 * **`typescript` as peerDependency.** Only consumers of the
 * `./static-analyzer` subpath need `typescript` at runtime; types-only
 * consumers of `@xdeck/runtime-api` don't pay for it.
 *
 * **Not in scope (deferred, flagged per call site):**
 *  - Aliased / destructured `xdeck` references (need symbol-table flow
 *    analysis; covers <5% of real-world package code).
 *  - Non-literal resource ids (`{entityName: someVar}`) — caller must
 *    pass a literal or declare the capability explicitly.
 *  - Cross-file analysis (each `.ts` file analysed independently).
 *  - Compiled `.js` source (today packages ship `.ts` per ADR 0003).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { capabilityForMethodCall, lookupXdeckMethod, type XdeckMethodMapping } from './method-mapping';

/** Path within the package where class transforms live (per ADR 0003 §1). */
const CLASS_TRANSFORMS_SUBDIR = path.join('classes', 'transforms');

export interface CapabilityUsageSite {
  /** File path relative to the package root (e.g. `classes/transforms/Sender.ts`). */
  file: string;
  /** 1-based line number of the call expression. */
  line: number;
}

export interface UsedCapabilityFinding {
  /**
   * Capability string the source-code call resolves to. Typed as `string`
   * (not `Capability`) because the analyzer must report USAGE faithfully —
   * including reserved strings like `'event:emit'` and `'class:invoke'`
   * (per §9.50.9.1) that aren't part of the grantable `Capability` union
   * but ARE valid call sites for the runtime to refuse. Validators treat
   * them all as strings; reservation rejection lives in the manifest
   * `checkCapabilities` path (Slice 2).
   */
  capability: string;
  /** Every distinct call site that resolves to this capability. */
  callSites: CapabilityUsageSite[];
}

export interface UnresolvableUsage {
  file: string;
  line: number;
  /** Source snippet (the offending expression). Useful in error messages. */
  expression: string;
  /** Why it can't be statically resolved. */
  reason: string;
}

export interface CapabilityAnalysisResult {
  /** Distinct capabilities the package USES, grouped by capability string. */
  used: UsedCapabilityFinding[];
  /** Call sites that referenced `xdeck` in a way the analyzer cannot resolve. */
  unresolvable: UnresolvableUsage[];
}

export interface AnalyzeOptions {
  /** Optional diagnostic sink — invoked for unreadable files /
   *  unlistable subdirs. Defaults to no-op. */
  onWarn?: (message: string) => void;
}

const noopWarn = (_: string): void => undefined;

/**
 * Walk every `.ts` file under `<packageDir>/classes/transforms/` and
 * collect the capability usage findings. Missing directory → empty
 * result (package has no class transforms, nothing to analyse).
 *
 * Consumers cross-reference `used` against the manifest's declared
 * capabilities and use `unresolvable` to fail install/publish with a
 * clear remediation message.
 */
export function analyzePackageDir(packageDir: string, opts: AnalyzeOptions = {}): CapabilityAnalysisResult {
  const onWarn = opts.onWarn ?? noopWarn;
  const transformsDir = path.join(packageDir, CLASS_TRANSFORMS_SUBDIR);
  if (!fs.existsSync(transformsDir) || !fs.statSync(transformsDir).isDirectory()) {
    return { used: [], unresolvable: [] };
  }
  const files = listTypeScriptFiles(transformsDir, onWarn);
  const used = new Map<string, CapabilityUsageSite[]>();
  const unresolvable: UnresolvableUsage[] = [];
  for (const absPath of files) {
    const relPath = path.relative(packageDir, absPath);
    let source: string;
    try {
      source = fs.readFileSync(absPath, 'utf8');
    } catch (err) {
      onWarn(`could not read ${absPath}: ${(err as Error).message}`);
      unresolvable.push({
        file: relPath,
        line: 0,
        expression: '',
        reason: `unreadable source file: ${(err as Error).message}`
      });
      continue;
    }
    analyzeOne(relPath, source, used, unresolvable);
  }
  return {
    used: [...used.entries()]
      .map(([capability, callSites]) => ({ capability, callSites }))
      .sort((a, b) => a.capability.localeCompare(b.capability)),
    unresolvable
  };
}

/**
 * Pure analysis of a single source string (no fs). Exported for tests
 * + future consumers who already have the source in memory.
 */
export function analyzeSource(file: string, source: string): CapabilityAnalysisResult {
  const used = new Map<string, CapabilityUsageSite[]>();
  const unresolvable: UnresolvableUsage[] = [];
  analyzeOne(file, source, used, unresolvable);
  return {
    used: [...used.entries()]
      .map(([capability, callSites]) => ({ capability, callSites }))
      .sort((a, b) => a.capability.localeCompare(b.capability)),
    unresolvable
  };
}

function analyzeOne(
  file: string,
  source: string,
  used: Map<string, CapabilityUsageSite[]>,
  unresolvable: UnresolvableUsage[]
): void {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, /*setParentNodes*/ true);
  const visit = (node: ts.Node, parent: ts.Node | null): void => {
    if (ts.isPropertyAccessExpression(node)) {
      inspectPropertyAccess(node, parent, sf, used, unresolvable);
    }
    ts.forEachChild(node, (child) => visit(child, node));
  };
  visit(sf, null);
}

function inspectPropertyAccess(
  node: ts.PropertyAccessExpression,
  parent: ts.Node | null,
  sf: ts.SourceFile,
  used: Map<string, CapabilityUsageSite[]>,
  unresolvable: UnresolvableUsage[]
): void {
  const chain = describePropertyChain(node);
  if (chain.root !== 'xdeck') return;
  // `xdeck.context.<field>` — always-available identity, no capability check.
  if (chain.members[0] === 'context') return;
  const depth = chain.members.length;
  // Skip 1-deep nodes that are part of a deeper chain (avoid double-firing
  // when visiting `xdeck.email.send` — we'd otherwise also visit the inner
  // `xdeck.email` and double-flag).
  if (depth === 1 && parent && ts.isPropertyAccessExpression(parent) && parent.expression === node) {
    return;
  }
  const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  const expression = node.getText(sf);
  if (depth !== 2) {
    // 1-deep standalone (`const e = xdeck.email`) OR 3+ deep
    // (`xdeck.email.send.bind(...)`). Both are forms the analyzer cannot
    // map to a single capability. The caller blocks install/publish.
    unresolvable.push({
      file: sf.fileName,
      line: line + 1,
      expression,
      reason:
        depth === 1
          ? `partial member access — store a domain alias prevents static analysis; call \`xdeck.<domain>.<method>(...)\` directly`
          : `chained method access (depth ${depth}) — only direct \`xdeck.<domain>.<method>(...)\` calls are statically analysable`
    });
    return;
  }
  // Exactly 2-deep. Either a method call (extract capability) or a loose reference.
  const method = `${chain.members[0]}.${chain.members[1]}`;
  const isCallee = parent && ts.isCallExpression(parent) && parent.expression === node ? parent : null;
  if (!isCallee) {
    unresolvable.push({
      file: sf.fileName,
      line: line + 1,
      expression,
      reason: `\`${expression}\` referenced without immediate call — store the call's RESULT, not the method itself, so the analyzer can see what's being invoked`
    });
    return;
  }
  const mapping = lookupXdeckMethod(method);
  if (!mapping) {
    // Unknown method. Runtime would reject with XDECK_UNKNOWN_METHOD; the
    // analyzer flags here so install fails early with a clearer reason.
    unresolvable.push({
      file: sf.fileName,
      line: line + 1,
      expression,
      reason: `unknown runtime-API method \`xdeck.${method}(...)\` — not in the §9.50 catalogue`
    });
    return;
  }
  const capability = resolveCapability(method, mapping, isCallee, expression);
  if (!capability.ok) {
    unresolvable.push({
      file: sf.fileName,
      line: line + 1,
      expression,
      reason: capability.reason
    });
    return;
  }
  const cap = capability.value;
  const sites = used.get(cap) ?? [];
  sites.push({ file: sf.fileName, line: line + 1 });
  used.set(cap, sites);
}

function resolveCapability(
  method: string,
  mapping: XdeckMethodMapping,
  call: ts.CallExpression,
  expression: string
): { ok: true; value: string } | { ok: false; reason: string } {
  if (mapping.kind === 'static' || mapping.kind === 'reserved') {
    const cap = capabilityForMethodCall(method);
    if (!cap) return { ok: false, reason: 'internal: unknown method despite lookup' };
    return { ok: true, value: cap };
  }
  // parameterized — extract literal resource id from the first arg.
  const resourceId = extractLiteralArg(call, mapping.argKey);
  if (!resourceId) {
    return {
      ok: false,
      reason: `\`${expression}\` requires a literal-string \`${mapping.argKey}\` in the first argument so the analyzer can compute the capability; non-literal references cannot be statically resolved`
    };
  }
  const cap = capabilityForMethodCall(method, resourceId);
  if (!cap) return { ok: false, reason: 'internal: parameterized lookup failed' };
  return { ok: true, value: cap };
}

function listTypeScriptFiles(dir: string, onWarn: (msg: string) => void): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (err) {
      onWarn(`could not list ${current}: ${(err as Error).message}`);
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out.sort();
}

// ─── helpers (exported for spec testing) ─────────────────────────────

export interface DescribedChain {
  root: string | null;
  members: string[];
}

export function describePropertyChain(node: ts.PropertyAccessExpression): DescribedChain {
  const members: string[] = [];
  let current: ts.Expression = node;
  while (ts.isPropertyAccessExpression(current)) {
    members.unshift(current.name.text);
    current = current.expression;
  }
  const root = ts.isIdentifier(current) ? current.text : null;
  return { root, members };
}

/**
 * Extract a literal-string value of the named property from the call's
 * first argument when shaped `({ <argKey>: 'literal' })`. Non-object,
 * non-literal, or missing → null (caller treats as unresolvable).
 */
export function extractLiteralArg(call: ts.CallExpression, argKey: string): string | null {
  const first = call.arguments[0];
  if (!first || !ts.isObjectLiteralExpression(first)) return null;
  for (const prop of first.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const name = prop.name;
    const propKey = ts.isIdentifier(name) ? name.text : ts.isStringLiteral(name) ? name.text : null;
    if (propKey !== argKey) continue;
    const value = prop.initializer;
    if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return value.text;
    return null;
  }
  return null;
}
