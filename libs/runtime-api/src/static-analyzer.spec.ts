/**
 * §9.50 Phase B Slice 7 — lib-level static analyzer spec.
 *
 * Owns the AST coverage for the analyzer; the backend wrapper spec keeps
 * only a thin smoke. Ported from the original backend spec verbatim
 * (just swaps `svc.analyzeSource()` / `svc.analyzePackage()` for the
 * top-level `analyzeSource()` / `analyzePackageDir()` function exports).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { analyzePackageDir, analyzeSource } from './static-analyzer';

describe('static-analyzer (lib)', () => {
  let packageDir: string;

  beforeEach(() => {
    packageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdeck-static-analyzer-'));
  });

  afterEach(() => {
    fs.rmSync(packageDir, { recursive: true, force: true });
  });

  function writeTransform(name: string, source: string): void {
    const dir = path.join(packageDir, 'classes', 'transforms');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), source);
  }

  // ── analyzeSource (pure, no fs) ─────────────────────────────────────

  describe('analyzeSource — direct xdeck.<X>.<Y>(...) calls', () => {
    it('extracts static capabilities from a single call', () => {
      const out = analyzeSource(
        'Sender.ts',
        `
        export class Sender {
          async run(payload: unknown) {
            await xdeck.email.send({ to: 'u@x', subject: 's', templateId: 't', data: {} });
          }
        }
        `
      );
      expect(out.unresolvable).toEqual([]);
      expect(out.used).toHaveLength(1);
      expect(out.used[0].capability).toBe('email:send');
      expect(out.used[0].callSites).toEqual([{ file: 'Sender.ts', line: expect.any(Number) }]);
    });

    it('§9.166 — a COMPOSED method reports every key it needs at the same call site', () => {
      // invoice.collectOnline records money in flight AND starts a gateway charge. Reporting
      // only invoice:settle would let a package that never declared payment:initiate pass
      // install and fail at its first real call.
      const out = analyzeSource(
        'Collect.ts',
        `class C { async run() { await xdeck.invoice.collectOnline({ invoiceId: 'i-1' }); } }`
      );
      expect(out.unresolvable).toEqual([]);
      const caps = out.used.map((u) => u.capability).sort();
      expect(caps).toEqual(['invoice:settle', 'payment:initiate']);
      for (const u of out.used) expect(u.callSites).toEqual([{ file: 'Collect.ts', line: expect.any(Number) }]);
    });

    it('§9.166 cluster 6 — invoice.refund records BOTH capabilities at the call site', () => {
      // Until the cluster landed this asserted the opposite (unknown method, no capability). Now an
      // install that sees a `refund` call must demand `payment:refund` as well as `invoice:credit`,
      // which is what the analyzer exists to make visible.
      const out = analyzeSource(
        'Refund.ts',
        `class R { async run() { await xdeck.invoice.refund({ paymentId: 'p-1' }); } }`
      );
      expect(out.unresolvable).toEqual([]);
      expect(out.used.map((u) => u.capability).sort()).toEqual(['invoice:credit', 'payment:refund']);
      for (const u of out.used) expect(u.callSites).toEqual([{ file: 'Refund.ts', line: expect.any(Number) }]);
    });

    it('maps notification.send to notification:send-in-app (NOT notification:send)', () => {
      const out = analyzeSource(
        'Notify.ts',
        `class N { async run() { await xdeck.notification.send({ userId: 'u', variant: 'toast', body: {} }); } }`
      );
      expect(out.used.map((u) => u.capability)).toEqual(['notification:send-in-app']);
    });

    it('aggregates multiple distinct capabilities into separate findings', () => {
      const out = analyzeSource(
        'Multi.ts',
        `
        class Multi {
          async run() {
            await xdeck.email.send({ to: 'a', subject: 'b', templateId: 'c', data: {} });
            await xdeck.notification.send({ userId: 'u', variant: 'toast', body: {} });
            await xdeck.notification.broadcast({ variant: 'banner', body: {} });
          }
        }
        `
      );
      expect(out.unresolvable).toEqual([]);
      expect(out.used.map((u) => u.capability).sort()).toEqual([
        'email:send',
        'notification:broadcast',
        'notification:send-in-app'
      ]);
    });

    it('collapses multiple call sites of the same capability into one finding with N sites', () => {
      const out = analyzeSource(
        'Repeat.ts',
        `
        class Repeat {
          async run() {
            await xdeck.email.send({ to: 'a', subject: 's', templateId: 't', data: {} });
            await xdeck.email.send({ to: 'b', subject: 's', templateId: 't', data: {} });
            await xdeck.email.send({ to: 'c', subject: 's', templateId: 't', data: {} });
          }
        }
        `
      );
      expect(out.used).toHaveLength(1);
      expect(out.used[0].capability).toBe('email:send');
      expect(out.used[0].callSites).toHaveLength(3);
      const lines = out.used[0].callSites.map((s) => s.line);
      expect(lines).toEqual([...lines].sort((a, b) => a - b));
      expect(new Set(lines).size).toBe(3);
    });
  });

  describe('analyzeSource — xdeck.context.<field> is NOT a capability', () => {
    it('reading xdeck.context.deckId does not register usage', () => {
      const out = analyzeSource('CtxReader.ts', `class CtxReader { read() { return xdeck.context.deckId; } }`);
      expect(out.used).toEqual([]);
      expect(out.unresolvable).toEqual([]);
    });

    it('reading xdeck.context.package.namespace (deep chain) is allowed', () => {
      const out = analyzeSource('Deep.ts', `class Deep { read() { return xdeck.context.package.namespace; } }`);
      expect(out.used).toEqual([]);
      expect(out.unresolvable).toEqual([]);
    });
  });

  describe('analyzeSource — identity-scoped methods are not capability calls (§9.169 PR-10)', () => {
    it.each([
      'integrator.callout({ connector: "c", method: "GET", path: "/items" })',
      'integrator.settings()',
      'capabilities.invoke({ capability: "x", payload: {} })'
    ])('xdeck.%s registers no usage and nothing unresolvable', (call) => {
      const out = analyzeSource('Door.ts', `class D { async run() { return xdeck.${call}; } }`);
      expect(out.used).toEqual([]);
      expect(out.unresolvable).toEqual([]);
    });

    it('an unknown method on the integrator domain is still unresolvable (the skip is per method)', () => {
      const out = analyzeSource('DoorX.ts', `class DX { async run() { return xdeck.integrator.frobnicate(); } }`);
      expect(out.used).toEqual([]);
      expect(out.unresolvable).toHaveLength(1);
      expect(out.unresolvable[0].reason).toMatch(/unknown runtime-API method/);
      expect(out.unresolvable[0].reason).toMatch(/integrator\.frobnicate/);
    });
  });

  describe('analyzeSource — parameterized resource extraction', () => {
    it('extracts entity:read:<entityName> from a literal string arg', () => {
      const out = analyzeSource(
        'EntityReader.ts',
        `class E { async run() { await xdeck.entity.read({ entityName: 'Patient', limit: 10 }); } }`
      );
      expect(out.unresolvable).toEqual([]);
      expect(out.used.map((u) => u.capability)).toEqual(['entity:read:Patient']);
    });

    it('extracts entity:write:<entityName> + secret:read:<key> in the same source', () => {
      const out = analyzeSource(
        'Mixed.ts',
        `
        class Mixed {
          async run() {
            await xdeck.entity.write({ entityName: 'Visit', op: 'insert', data: {} });
            const s = await xdeck.secret.read({ key: 'STRIPE_KEY' });
          }
        }
        `
      );
      expect(out.unresolvable).toEqual([]);
      expect(out.used.map((u) => u.capability).sort()).toEqual(['entity:write:Visit', 'secret:read:STRIPE_KEY']);
    });

    it('two distinct entity names → two distinct capabilities', () => {
      const out = analyzeSource(
        'TwoEntities.ts',
        `
        class T {
          async run() {
            await xdeck.entity.read({ entityName: 'Patient' });
            await xdeck.entity.read({ entityName: 'Visit' });
          }
        }
        `
      );
      expect(out.used.map((u) => u.capability).sort()).toEqual(['entity:read:Patient', 'entity:read:Visit']);
    });

    it('non-literal resource id (variable reference) → unresolvable', () => {
      const out = analyzeSource(
        'Dynamic.ts',
        `
        class D {
          async run(name: string) {
            await xdeck.entity.read({ entityName: name });
          }
        }
        `
      );
      expect(out.used).toEqual([]);
      expect(out.unresolvable).toHaveLength(1);
      expect(out.unresolvable[0].reason).toMatch(/literal-string `entityName`/);
    });

    it('first arg is not an object (template literal / null) → unresolvable', () => {
      const out = analyzeSource('Wrong.ts', `class W { async run() { await xdeck.entity.read(null); } }`);
      expect(out.unresolvable).toHaveLength(1);
      expect(out.unresolvable[0].reason).toMatch(/literal-string `entityName`/);
    });

    it('first arg missing argKey property → unresolvable', () => {
      const out = analyzeSource('NoKey.ts', `class N { async run() { await xdeck.entity.read({ limit: 10 }); } }`);
      expect(out.unresolvable).toHaveLength(1);
    });
  });

  describe('analyzeSource — reserved methods (§9.50.9.1)', () => {
    it('xdeck.event.emit(...) surfaces as used: "event:emit"', () => {
      const out = analyzeSource(
        'Emit.ts',
        `class E { async run() { await xdeck.event.emit({ eventName: 'x', payload: {} }); } }`
      );
      expect(out.used.map((u) => u.capability)).toEqual(['event:emit']);
      expect(out.unresolvable).toEqual([]);
    });

    it('xdeck.class.invoke(...) surfaces as used: "class:invoke"', () => {
      const out = analyzeSource(
        'Inv.ts',
        `class I { async run() { await xdeck.class.invoke({ classId: 'Notify', input: {} }); } }`
      );
      expect(out.used.map((u) => u.capability)).toEqual(['class:invoke']);
    });
  });

  describe('analyzeSource — unresolvable patterns', () => {
    // Until 2026-11-07 this alias was a finding; the one reading follows a `const` to its calls.
    it('aliasing `const e = xdeck.email; e.send(...)` is followed to the call', () => {
      const out = analyzeSource(
        'Alias.ts',
        `
        class A {
          async run() {
            const e = xdeck.email;
            await e.send({ to: 'a', subject: 's', templateId: 't', data: {} });
          }
        }
        `
      );
      expect(out.used).toEqual([{ capability: 'email:send', callSites: [{ file: 'Alias.ts', line: 5 }] }]);
      expect(out.unresolvable).toEqual([]);
    });

    it('storing the method reference `const fn = xdeck.email.send` → unresolvable', () => {
      const out = analyzeSource('Store.ts', `class S { async run() { const fn = xdeck.email.send; await fn({}); } }`);
      expect(out.unresolvable).toHaveLength(1);
      expect(out.unresolvable[0].reason).toMatch(/referenced without immediate call/);
      expect(out.unresolvable[0].expression).toBe('xdeck.email.send');
    });

    it('chained access `xdeck.email.send.bind(...)` → unresolvable (depth >2)', () => {
      const out = analyzeSource(
        'Bind.ts',
        `class B { async run() { const f = xdeck.email.send.bind(null); await f({}); } }`
      );
      expect(out.unresolvable.length).toBeGreaterThanOrEqual(1);
      const reasons = out.unresolvable.map((u) => u.reason);
      expect(reasons.some((r) => /depth 3/.test(r))).toBe(true);
    });

    it('unknown method `xdeck.frobnicate.foo(...)` → unresolvable + clear reason', () => {
      const out = analyzeSource('Frob.ts', `class F { async run() { await xdeck.frobnicate.foo({}); } }`);
      expect(out.used).toEqual([]);
      expect(out.unresolvable).toHaveLength(1);
      expect(out.unresolvable[0].reason).toMatch(/unknown runtime-API method/);
      expect(out.unresolvable[0].reason).toMatch(/frobnicate\.foo/);
    });

    it('known domain + unknown method `xdeck.email.frobnicate(...)` → unresolvable', () => {
      const out = analyzeSource('EFroh.ts', `class EF { async run() { await xdeck.email.frobnicate({}); } }`);
      expect(out.unresolvable).toHaveLength(1);
      expect(out.unresolvable[0].reason).toMatch(/unknown/);
    });
  });

  describe('analyzeSource — non-xdeck identifiers are ignored', () => {
    it('other-named root identifier (e.g. lodash.<X>.<Y>) is not analysed', () => {
      const out = analyzeSource(
        'Other.ts',
        `
        const _ = require('lodash');
        class O { run() { return _.fp.map([1,2,3], x => x * 2); } }
        `
      );
      expect(out.used).toEqual([]);
      expect(out.unresolvable).toEqual([]);
    });

    it('local variable named `xdeck` (shadow) — analyser DOES still flag (Phase 1 limitation, documented)', () => {
      // Phase 1 does not do flow analysis — locks the current behaviour so a
      // future fix (symbol-table tracking) is a deliberate change, not a
      // surprise regression.
      const out = analyzeSource(
        'Shadow.ts',
        `
        class Sh {
          run() {
            const xdeck = { email: { send: () => {} } };
            xdeck.email.send();
          }
        }
        `
      );
      expect(out.used.map((u) => u.capability)).toEqual(['email:send']);
    });
  });

  // ── analyzePackageDir (fs walk) ──────────────────────────────────────

  describe('analyzePackageDir — fs walk', () => {
    it('returns empty result when classes/ does not exist', () => {
      const out = analyzePackageDir(packageDir);
      expect(out).toEqual({ used: [], unresolvable: [], acknowledged: [] });
    });

    it('walks every .ts file under classes/transforms/ and aggregates findings', () => {
      writeTransform(
        'Sender.ts',
        `class S { async run() { await xdeck.email.send({ to: 'a', subject: 's', templateId: 't', data: {} }); } }`
      );
      writeTransform(
        'Notifier.ts',
        `class N { async run() { await xdeck.notification.send({ userId: 'u', variant: 'toast', body: {} }); } }`
      );
      const out = analyzePackageDir(packageDir);
      expect(out.unresolvable).toEqual([]);
      expect(out.used.map((u) => u.capability).sort()).toEqual(['email:send', 'notification:send-in-app']);
      const emailFinding = out.used.find((u) => u.capability === 'email:send');
      expect(emailFinding?.callSites.map((s) => s.file)).toEqual([path.join('classes', 'transforms', 'Sender.ts')]);
    });

    it('walks recursively through subdirectories under transforms/', () => {
      const nestedDir = path.join(packageDir, 'classes', 'transforms', 'nested');
      fs.mkdirSync(nestedDir, { recursive: true });
      fs.writeFileSync(
        path.join(nestedDir, 'Deep.ts'),
        `class D { async run() { await xdeck.email.send({ to: 'a', subject: 's', templateId: 't', data: {} }); } }`
      );
      const out = analyzePackageDir(packageDir);
      expect(out.used.map((u) => u.capability)).toEqual(['email:send']);
      expect(out.used[0].callSites[0].file).toEqual(path.join('classes', 'transforms', 'nested', 'Deep.ts'));
    });

    it('ignores .d.ts files (declaration-only, no runtime calls)', () => {
      writeTransform(
        'Sender.ts',
        `class S { run() { xdeck.email.send({ to: 'a', subject: 's', templateId: 't', data: {} }); } }`
      );
      writeTransform('Sender.d.ts', `export declare class Sender { run(): void; }`);
      const out = analyzePackageDir(packageDir);
      expect(out.used).toHaveLength(1);
    });

    it('non-ts files are ignored', () => {
      const dir = path.join(packageDir, 'classes', 'transforms');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'README.md'), '# Notes');
      fs.writeFileSync(path.join(dir, 'config.json'), '{}');
      const out = analyzePackageDir(packageDir);
      expect(out).toEqual({ used: [], unresolvable: [], acknowledged: [] });
    });

    // A folder the walk cannot list hides every class in it; the verdict must not read clean.
    it('an unlistable folder is a finding, never a skip', () => {
      // chmod does not hide a folder from root or on Windows; everywhere else the branch must run.
      if (process.platform === 'win32' || process.getuid?.() === 0) return;
      const hidden = path.join(packageDir, 'classes', 'jobs');
      fs.mkdirSync(hidden, { recursive: true });
      fs.writeFileSync(path.join(hidden, 'Send.ts'), `export async function s() { await xdeck.email.send({}); }`);
      fs.chmodSync(hidden, 0o000);
      try {
        const warnings: string[] = [];
        const out = analyzePackageDir(packageDir, { onWarn: (m) => warnings.push(m) });
        expect(out.used).toEqual([]);
        expect(out.unresolvable).toEqual([
          expect.objectContaining({
            file: path.join('classes', 'jobs'),
            line: 0,
            reason: 'unlistable folder — the classes in it cannot be read (EACCES)'
          })
        ]);
        // The finding reaches the install preview's caller: the server path stays in the log.
        expect(out.unresolvable[0].reason).not.toContain(packageDir);
        expect(warnings).toEqual([expect.stringMatching(/could not list .*jobs/)]);
      } finally {
        fs.chmodSync(hidden, 0o755);
      }
    });

    it('an unreadable class file is a finding naming the error code, never the server path', () => {
      if (process.platform === 'win32' || process.getuid?.() === 0) return;
      const dir = path.join(packageDir, 'classes', 'jobs');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'Send.ts');
      fs.writeFileSync(file, `export async function s() { await xdeck.email.send({}); }`);
      fs.chmodSync(file, 0o000);
      try {
        const warnings: string[] = [];
        const out = analyzePackageDir(packageDir, { onWarn: (m) => warnings.push(m) });
        expect(out.used).toEqual([]);
        expect(out.unresolvable).toEqual([
          {
            file: path.join('classes', 'jobs', 'Send.ts'),
            line: 0,
            expression: '',
            reason: 'unreadable source file (EACCES)'
          }
        ]);
        expect(warnings).toEqual([expect.stringContaining(file)]);
      } finally {
        fs.chmodSync(file, 0o644);
      }
    });

    it('onWarn callback fires when a file cannot be read', () => {
      const dir = path.join(packageDir, 'classes', 'transforms');
      fs.mkdirSync(dir, { recursive: true });
      const filePath = path.join(dir, 'Unreadable.ts');
      fs.writeFileSync(filePath, 'class X {}');
      // Make the file unreadable. On platforms where chmod is not effective
      // (Windows), skip the assertion; the spec still verifies the no-op default.
      try {
        fs.chmodSync(filePath, 0o000);
        const warnings: string[] = [];
        const out = analyzePackageDir(packageDir, { onWarn: (m) => warnings.push(m) });
        // Either fs read succeeded (test env doesn't honour chmod) or we got
        // a warning + unresolvable row.
        if (warnings.length > 0) {
          expect(warnings[0]).toMatch(/could not read/);
          expect(out.unresolvable.some((u) => /unreadable source file/.test(u.reason))).toBe(true);
        }
      } finally {
        try {
          fs.chmodSync(filePath, 0o644);
        } catch {
          /* noop */
        }
      }
    });
  });

  // ── Accessor form (2026-11-07) ─────────────────────────────────────────
  // Every first-party package calls `xdeck().<domain>.<method>(…)`, often through a `const`
  // alias, from classes outside `classes/transforms/`. The transforms-only walk saw none of it, so
  // a package that read an entity it never declared passed every check and was refused at run time.
  // Since 2026-11-07 this is the only reading — install, the release workflow and the fleet gate.
  describe('accessor form', () => {
    const caps = (src: string): string[] => analyzeSource('f.ts', src).used.map((u) => u.capability);

    function writeClass(rel: string, source: string): void {
      const full = path.join(packageDir, 'classes', rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, source);
    }

    it('one reading: the accessor form is read with no option, and every result lists acknowledged', () => {
      const out = analyzeSource('f.ts', `async function r() { await xdeck().entity.read({ entityName: 'Patient' }); }`);
      expect(out).toEqual({
        used: [{ capability: 'entity:read:Patient', callSites: [{ file: 'f.ts', line: 1 }] }],
        unresolvable: [],
        acknowledged: []
      });
    });

    it('reads `xdeck().<domain>.<method>(...)` like the direct form', () => {
      const out = analyzeSource('f.ts', `async function r() { await xdeck().entity.read({ entityName: 'Patient' }); }`);
      expect(out.used).toEqual([{ capability: 'entity:read:Patient', callSites: [{ file: 'f.ts', line: 1 }] }]);
      expect(out.unresolvable).toEqual([]);
      expect(out.acknowledged).toEqual([]);
    });

    it('resolves a const alias of one domain, and of the whole API', () => {
      expect(
        caps(`async function r() {
          const api = xdeck().entity;
          await api.read({ entityName: 'ScheduledReport' });
          await api.write({ entityName: 'ReportDelivery', op: 'insert', data: {} });
          const x = xdeck();
          await x.email.send({ to: 'a' });
        }`)
      ).toEqual(['email:send', 'entity:read:ScheduledReport', 'entity:write:ReportDelivery']);
    });

    it('ADR-0035: readAs with a computed entity name is the static entity:read-delegated, never unresolvable', () => {
      // The record type a delegated read names is bounded by the person's delegation (checked by
      // the host on every call), not by the manifest — so it needs no dynamic marker, and the
      // analyzer must not ask for one. A per-entity `entity:read:<x>` here would be the old,
      // wrong model: package authority over a report a person wrote.
      const out = analyzeSource(
        'f.ts',
        `async function r(d: { delegationId: string; entityName: string }) {
          const api = xdeck().entity;
          return api.readAs({ delegationId: d.delegationId, entityName: d.entityName, limit: 10 });
        }`
      );
      expect(out.used).toEqual([{ capability: 'entity:read-delegated', callSites: [{ file: 'f.ts', line: 3 }] }]);
      expect(out.unresolvable).toEqual([]);
      expect(out.acknowledged).toEqual([]);
    });

    it('a truthiness probe of an optional mount is not an escape', () => {
      const out = analyzeSource(
        'f.ts',
        `async function r() {
          const jobApi = xdeck().job;
          if (jobApi) await jobApi.schedule({ name: 'n', cron: '0 4 * * *', classId: 'C' });
          if (!xdeck().ai) return;
        }`
      );
      expect(out.used.map((u) => u.capability)).toEqual(['job:schedule']);
      expect(out.unresolvable).toEqual([]);
    });

    it('a parameter that shadows an alias is not the alias', () => {
      const out = analyzeSource(
        'f.ts',
        `const api = xdeck().entity;
         function f(api: { read(a: unknown): unknown }) { return api.read({ entityName: 'Other' }); }`
      );
      expect(out.used).toEqual([]);
      expect(out.unresolvable).toEqual([]);
    });

    it('an alias or a bare accessor that escapes as a value is unresolvable — the gate fails on what it cannot read', () => {
      const out = analyzeSource(
        'f.ts',
        `function a() { const api = xdeck().entity; helper(api); }
         function b(store: { api?: unknown }) { store.api = xdeck(); }
         function c() { const { entity } = xdeck(); return entity; }
         function d() { let api = xdeck().entity; return api; }`
      );
      const reasons = out.unresolvable.map((u) => `${u.line}:${u.reason.slice(0, 40)}`);
      expect(reasons).toEqual([
        expect.stringMatching(/^1:`api` \(an alias of the runtime API\) esca/),
        expect.stringMatching(/^2:bare `xdeck\(\)` used as a value/),
        expect.stringMatching(/^3:bare `xdeck\(\)` used as a value/),
        expect.stringMatching(/^4:partial member access/)
      ]);
      expect(out.used).toEqual([]);
    });

    it('a computed resource id is unresolvable unless the statement carries a reasoned marker', () => {
      const unmarked = analyzeSource(
        'f.ts',
        `async function r(d: { e: string }) { await xdeck().entity.read({ entityName: d.e }); }`
      );
      expect(unmarked.unresolvable).toHaveLength(1);
      expect(unmarked.unresolvable[0].reason).toMatch(/literal-string `entityName`/);
      expect(unmarked.acknowledged).toEqual([]);

      const marked = analyzeSource(
        'f.ts',
        `async function r(d: { e: string }) {
          const api = xdeck().entity;
          // xdeck-capability-dynamic: a report reads the entity its definition names
          const rows = await api.read({ entityName: d.e });
          return rows;
        }`
      );
      expect(marked.unresolvable).toEqual([]);
      expect(marked.acknowledged).toEqual([
        expect.objectContaining({ line: 4, note: 'a report reads the entity its definition names' })
      ]);

      const terse = analyzeSource(
        'f.ts',
        `async function r(d: { e: string }) {
          // xdeck-capability-dynamic: ok
          await xdeck().entity.read({ entityName: d.e });
        }`
      );
      expect(terse.unresolvable).toHaveLength(1);
      expect(terse.acknowledged).toEqual([]);
    });

    it('identity-scoped reads stay skipped; a kernel method is still a capability', () => {
      expect(
        caps(`async function r() {
          xdeck().context.deckId;
          await xdeck().config.get('k');
          await xdeck().telemetry.track({ eventName: 'campaign_sent', props: {} });
        }`)
      ).toEqual(['telemetry:track']);
    });

    it('value wrappers inside the chain are looked through, without a double finding', () => {
      const out = analyzeSource('f.ts', `async function r() { await xdeck().entity!.read({ entityName: 'A' }); }`);
      expect(out.used.map((u) => u.capability)).toEqual(['entity:read:A']);
      expect(out.unresolvable).toEqual([]);
    });

    it('an unknown method through an alias is still refused by name', () => {
      const out = analyzeSource('f.ts', `async function r() { const api = xdeck().entity; await api.frobnicate({}); }`);
      expect(out.unresolvable).toEqual([
        expect.objectContaining({
          reason: expect.stringMatching(/unknown runtime-API method `xdeck\.entity\.frobnicate/)
        })
      ]);
    });

    it('a helper that forwards its parameter is judged at its call sites, transitively', () => {
      const out = analyzeSource(
        'f.ts',
        `async function resolveByCode(entityName: string, code: string) {
          return xdeck().entity.read({ entityName, where: { code }, limit: 1 });
        }
        async function idem(e: string, data: object) {
          const api = xdeck().entity;
          await api.write({ entityName: e, op: 'insert', data });
          return api.read({ entityName: e, limit: 1 });
        }
        const ensure = (entityName: string) => idem(entityName, {});
        export class Job {
          async run(name: string) {
            await resolveByCode('OrderStatus', 'open');
            await ensure('Sale');
            await resolveByCode(name, 'x');
          }
        }`
      );
      expect(out.used).toEqual([
        { capability: 'entity:read:OrderStatus', callSites: [{ file: 'f.ts', line: 12 }] },
        { capability: 'entity:read:Sale', callSites: [{ file: 'f.ts', line: 13 }] },
        { capability: 'entity:write:Sale', callSites: [{ file: 'f.ts', line: 13 }] }
      ]);
      // `run` is a method nothing calls — an entry point the platform fills — so `name` is unknown.
      expect(out.unresolvable).toEqual([
        expect.objectContaining({
          line: 14,
          reason: expect.stringMatching(/^`resolveByCode\(\.\.\.\)` passes argument 1 on/)
        })
      ]);
    });

    it('a seed table, a destructured column and a choice between literals are known values', () => {
      expect(
        caps(`const SEED_TABLES: { entityName: string; rows: object[] }[] = [
            { entityName: 'CampaignStatus', rows: [] },
            { entityName: 'Segment', rows: [] }
          ];
          async function run(admissionId?: string) {
            const api = xdeck().entity;
            for (const table of SEED_TABLES) await api.read({ entityName: table.entityName });
            for (const { entityName } of SEED_TABLES) await api.write({ entityName, op: 'insert', data: {} });
            const contextEntity = admissionId ? 'Admission' : 'Encounter';
            await api.read({ entityName: contextEntity });
          }`)
      ).toEqual([
        'entity:read:Admission',
        'entity:read:CampaignStatus',
        'entity:read:Encounter',
        'entity:read:Segment',
        'entity:write:CampaignStatus',
        'entity:write:Segment'
      ]);
    });

    it('a table row without a known value keeps the read unresolvable', () => {
      const out = analyzeSource(
        'f.ts',
        `const T = [{ entityName: 'A' }, { entityName: pick() }];
         async function run() { for (const t of T) await xdeck().entity.read({ entityName: t.entityName }); }`
      );
      expect(out.used).toEqual([]);
      expect(out.unresolvable).toHaveLength(1);
    });

    it('a typeof probe of a method on an older host calls nothing', () => {
      const out = analyzeSource(
        'f.ts',
        `async function r() {
          const consumer = xdeck().consumer;
          if (typeof consumer.updateOwnProfile !== 'function') return;
          await consumer.updateOwnProfile({});
        }`
      );
      expect(out.used.map((u) => u.capability)).toEqual(['consumer:profile-write']);
      expect(out.unresolvable).toEqual([]);
    });

    it('one marker over a switch acknowledges its cases; a marker never covers an unknown method', () => {
      const out = analyzeSource(
        'f.ts',
        `async function load(kind: string, d: { e: string; f: string }) {
          const api = xdeck().entity;
          // xdeck-capability-dynamic: each report kind reads the entity its definition names
          switch (kind) {
            case 'a':
              return api.read({ entityName: d.e });
            default:
              return api.read({ entityName: d.f });
          }
        }
        async function bad() {
          // xdeck-capability-dynamic: this reason does not excuse a method that does not exist
          await xdeck().entity.frobnicate({});
        }`
      );
      expect(out.acknowledged!.map((a) => a.line)).toEqual([6, 8]);
      expect(out.unresolvable).toEqual([
        expect.objectContaining({ line: 13, reason: expect.stringMatching(/unknown runtime-API method/) })
      ]);
    });

    it('a function that returns the API, or one of several domains, is read where it is called through', () => {
      const out = analyzeSource(
        'f.ts',
        `export function requirePayment() {
          const p = xdeck().payment;
          if (!p) throw new Error('payment seam unavailable');
          return p;
        }
        export class SendCampaign {
          async settle() { await requirePayment().initiate({ amount: 1 }); }
          async dispatch(channel: string) {
            const api = this.channelApi(channel);
            if (!api) return false;
            return api.send({ to: 'a' });
          }
          private channelApi(channel: string) {
            const x = xdeck();
            switch (channel) {
              case 'email':
                return x.email;
              case 'sms':
                return x.sms;
              default:
                return undefined;
            }
          }
        }`
      );
      expect(out.used.map((u) => u.capability)).toEqual(['email:send', 'payment:initiate', 'sms:send']);
      expect(out.unresolvable).toEqual([]);
    });

    it('a chain with several roots is judged once per root, with one finding for what they share', () => {
      const out = analyzeSource(
        'f.ts',
        `class C {
          private pick(c: boolean) { const x = xdeck(); return c ? x.email : x.sms; }
          run(c: boolean) { const api = this.pick(c); const send = api.send; return send; }
        }`
      );
      expect(out.unresolvable.map((u) => `${u.line}:${u.reason.slice(0, 21)}`)).toEqual(['3:`api.send` referenced']);
      expect(out.used).toEqual([]);
    });

    it('the API from such a function still escapes when passed on; a function used as a value, or a part-API choice, is not followed', () => {
      const out = analyzeSource(
        'f.ts',
        `function requireEntity() { return xdeck().entity; }
         function leak() { return keep(requireEntity()); }
         function requireJob() { return xdeck().job; }
         const factories = [requireJob];
         function use() { return requireJob().schedule({ name: 'n', cron: '0 4 * * *', classId: 'C' }); }
         function pick(other: unknown, c: boolean) { const a = c ? xdeck().entity : other; return a; }`
      );
      expect(out.unresolvable.map((u) => `${u.line}:${u.reason.slice(0, 40)}`)).toEqual([
        expect.stringMatching(/^2:`requireEntity\(\)` returns the runtime/),
        expect.stringMatching(/^3:partial member access/),
        expect.stringMatching(/^6:partial member access/)
      ]);
      expect(out.used).toEqual([]);
    });

    it('the API passed to a parameter every caller fills with it is read inside; one caller passing something else keeps it an escape', () => {
      const out = analyzeSource(
        'f.ts',
        `export class AbdmShareBundle {
          async run(input: { id: string }) {
            const api = xdeck().entity;
            const encounters = await this.loadEncounters(api, input.id);
            const diagnoses = await this.loadChildren(api, 'Diagnosis', input.id);
            return { encounters, diagnoses };
          }
          private async loadEncounters(api: Api, patientId: string) {
            return api.read({ entityName: 'Encounter', where: { patientId } });
          }
          private async loadChildren(api: Api, entityName: string, encounterId: string) {
            return api.read({ entityName, where: { encounterId } });
          }
        }
        function mixed(store: { read(a: unknown): unknown }) { return store.read({ entityName: 'Hidden' }); }
        function callsMixed() { mixed(xdeck().entity); mixed({ read: () => null }); }`
      );
      expect(out.used).toEqual([
        { capability: 'entity:read:Diagnosis', callSites: [{ file: 'f.ts', line: 5 }] },
        { capability: 'entity:read:Encounter', callSites: [{ file: 'f.ts', line: 9 }] }
      ]);
      expect(out.unresolvable).toEqual([
        expect.objectContaining({ line: 16, reason: expect.stringMatching(/^partial member access/) })
      ]);
    });

    it('a plain function nothing calls forwards nothing; an uncalled method may be an entry point; a function used as a value has unseen callers', () => {
      const out = analyzeSource(
        'f.ts',
        `export async function resolveByCode(entityName: string) {
          return xdeck().entity.read({ entityName, limit: 1 });
        }
        export async function lookup(entityName: string) {
          return xdeck().entity.read({ entityName, limit: 1 });
        }
        export const handlers = { lookup };
        export class Report {
          async run(entityName: string) {
            return xdeck().entity.read({ entityName });
          }
          async start() {
            await this.load('Fixed');
            return ['A'].map(this.load);
          }
          private async load(entityName: string) {
            return xdeck().entity.read({ entityName });
          }
        }`
      );
      expect(out.used).toEqual([]);
      expect(out.unresolvable.map((u) => u.line)).toEqual([5, 10, 17]);
    });

    it('a namespace import and a renamed import reach the same functions; a namespace member taken as a value opens it', () => {
      writeClass(
        'transforms/lib/runtime.ts',
        `export function requirePayment() {
          const p = xdeck().payment;
          if (!p) throw new Error('payment seam unavailable');
          return p;
        }
        export async function resolveByCode(entityName: string) {
          return xdeck().entity.read({ entityName, limit: 1 });
        }
        export async function findByCode(entityName: string) {
          return xdeck().entity.read({ entityName, limit: 1 });
        }`
      );
      writeClass(
        'transforms/Settle.ts',
        `import * as rt from './lib/runtime';
        import { resolveByCode as byCode } from './lib/runtime';
        export class Settle {
          async run() {
            await rt.requirePayment().initiate({ amount: 1 });
            await byCode('BillStatus');
            const find = rt.findByCode;
            await find('X');
          }
        }`
      );
      const out = analyzePackageDir(packageDir);
      const settle = path.join('classes', 'transforms', 'Settle.ts');
      expect(out.used).toEqual([
        { capability: 'entity:read:BillStatus', callSites: [{ file: settle, line: 6 }] },
        { capability: 'payment:initiate', callSites: [{ file: settle, line: 5 }] }
      ]);
      expect(out.unresolvable).toEqual([
        expect.objectContaining({ file: path.join('classes', 'transforms', 'lib', 'runtime.ts'), line: 10 })
      ]);
    });

    it('a helper in lib/ is resolved where another file calls it', () => {
      writeClass(
        'transforms/lib/idempotency.ts',
        `export async function idempotentInsert(entityName: string, data: object) {
          const api = xdeck().entity;
          await api.write({ entityName, op: 'insert', data });
          return api.read({ entityName, limit: 1 });
        }`
      );
      writeClass(
        'transforms/RecordSale.ts',
        `import { idempotentInsert } from './lib/idempotency';
        export async function run() { await idempotentInsert('Sale', {}); }`
      );
      const out = analyzePackageDir(packageDir);
      const at = { file: path.join('classes', 'transforms', 'RecordSale.ts'), line: 2 };
      expect(out.used).toEqual([
        { capability: 'entity:read:Sale', callSites: [at] },
        { capability: 'entity:write:Sale', callSites: [at] }
      ]);
      expect(out.unresolvable).toEqual([]);
    });

    it('analyzePackageDir walks every class under classes/ and skips specs', () => {
      writeClass(
        'jobs/Seed.ts',
        `export async function s() { await xdeck().entity.write({ entityName: 'DrugSchedule', op: 'insert', data: {} }); }`
      );
      writeClass(
        'ReportScheduler.ts',
        `export async function r() { await xdeck().entity.read({ entityName: 'ScheduledReport' }); }`
      );
      writeClass('jobs/__tests__/Seed.spec.ts', `xdeck().entity.read({ entityName: 'FromSpec' });`);
      writeClass('jobs/Seed.test.ts', `xdeck().entity.read({ entityName: 'FromTest' });`);
      writeClass('transforms/T.ts', `export async function t() { await xdeck.email.send({ to: 'a' }); }`);

      const accessor = analyzePackageDir(packageDir);
      expect(accessor.used.map((u) => u.capability)).toEqual([
        'email:send',
        'entity:read:ScheduledReport',
        'entity:write:DrugSchedule'
      ]);
      expect(accessor.unresolvable).toEqual([]);
      expect(accessor.acknowledged).toEqual([]);
    });
  });

  // ── The injected global and the accessor by name (2026-11-07) ──────────
  // Both readings once passed a bare `xdeck` that was aliased, destructured, passed on or read
  // off `globalThis` without a word, and the walk knows the accessor only by its name. Each shape
  // below is now read or reported — a gate must fail on what it cannot read.
  describe('the injected global and the accessor by name', () => {
    const inMethod = (body: string): string => `export class T { x: unknown; async run(name: string) { ${body} } }`;
    const withAccessor = (body: string): string => `import { xdeck } from './lib/runtime';\n${inMethod(body)}`;
    const reasons = (src: string): string[] => analyzeSource('T.ts', src).unresolvable.map((u) => u.reason);

    it('a `const` of the bare global is followed to its calls', () => {
      const out = analyzeSource('T.ts', inMethod(`const x = xdeck; await x.email.send({});`));
      expect(out.used.map((u) => u.capability)).toEqual(['email:send']);
      expect(out.unresolvable).toEqual([]);
    });

    it.each([
      ['destructured', `const { email } = xdeck; await email.send({});`],
      ['passed to a call', `foo(xdeck);`],
      ['indexed by a string', `await xdeck['email'].send({});`],
      ['stored on this', `this.x = xdeck;`],
      ['spread', `const o = { ...xdeck };`],
      ['a shorthand property', `const o = { xdeck };`]
    ])('the bare global %s is a finding', (_shape, body) => {
      const out = analyzeSource('T.ts', inMethod(body));
      expect(out.used).toEqual([]);
      expect(out.unresolvable).toEqual([
        expect.objectContaining({ reason: expect.stringMatching(/^the runtime global `xdeck` used as a value — /) })
      ]);
    });

    it('a probe of the global is not an escape', () => {
      expect(reasons(inMethod(`if (!xdeck) return; if (typeof xdeck === 'undefined') return;`))).toEqual([]);
    });

    it('an ambient `declare const xdeck` still names the global', () => {
      const out = analyzeSource(
        'T.ts',
        `declare const xdeck: any;\n${inMethod(`const x = xdeck; await x.sms.send({});`)}`
      );
      expect(out.used.map((u) => u.capability)).toEqual(['sms:send']);
      expect(out.unresolvable).toEqual([]);
    });

    it.each([
      ['globalThis.xdeck', `await globalThis.xdeck.email.send({});`, 'email:send'],
      ['a cast global object', `await (globalThis as any).xdeck.entity.read({ entityName: 'P' });`, 'entity:read:P'],
      ['an element access', `await (globalThis as any)['xdeck'].email.send({});`, 'email:send'],
      ['self', `await (self as any).xdeck.sms.send({});`, 'sms:send'],
      ['a const of it', `const rt = (globalThis as any).xdeck; await rt.sms.send({});`, 'sms:send']
    ])('the global read off %s is the API', (_shape, body, capability) => {
      const out = analyzeSource('T.ts', inMethod(body));
      expect(out.used.map((u) => u.capability)).toEqual([capability]);
      expect(out.unresolvable).toEqual([]);
    });

    it('the global read off the global object escapes like `xdeck()`', () => {
      expect(reasons(inMethod(`foo((globalThis as any).xdeck);`))).toEqual([
        expect.stringMatching(/^bare `\(globalThis as any\)\.xdeck` used as a value — /)
      ]);
    });

    it('a local named like a global object is not the global object', () => {
      expect(analyzeSource('T.ts', inMethod(`const self = { xdeck: 1 }; foo(self.xdeck);`))).toEqual({
        used: [],
        unresolvable: [],
        acknowledged: []
      });
    });

    it('the accessor definition may return the global, and its callers are read by name', () => {
      fs.mkdirSync(path.join(packageDir, 'classes', 'lib'), { recursive: true });
      fs.writeFileSync(
        path.join(packageDir, 'classes', 'lib', 'runtime.ts'),
        `export function xdeck(): any {
          const x = (globalThis as { xdeck?: any }).xdeck;
          if (!x) throw new Error('runtime unavailable');
          return x;
        }`
      );
      writeTransform(
        'Send.ts',
        `import { xdeck } from '../lib/runtime';\nexport async function s() { await xdeck().email.send({}); }`
      );
      const out = analyzePackageDir(packageDir);
      expect(out.used).toEqual([
        { capability: 'email:send', callSites: [{ file: path.join('classes', 'transforms', 'Send.ts'), line: 2 }] }
      ]);
      expect(out.unresolvable).toEqual([]);
    });

    it('an arrow accessor is a definition too, and a call inside a definition is still judged', () => {
      expect(
        analyzeSource('runtime.ts', `export const xdeck = (): any => (globalThis as any).xdeck;`).unresolvable
      ).toEqual([]);
      const inside = analyzeSource(
        'runtime.ts',
        `export function xdeck(): any { const x = (globalThis as any).xdeck; void x.email.send({}); return x; }`
      );
      expect(inside.used.map((u) => u.capability)).toEqual(['email:send']);
    });

    it('another function that returns the global and is passed on is a finding', () => {
      expect(
        reasons(
          `export function other(): any { return (globalThis as any).xdeck; }\nexport function leak(f: any) { f(other); }`
        )
      ).toEqual([expect.stringMatching(/^bare `\(globalThis as any\)\.xdeck` used as a value — /)]);
    });

    it.each([
      ['passed to a call', withAccessor(`foo(xdeck);`)],
      ['aliased', withAccessor(`const rt = xdeck; await rt().email.send({});`)],
      ['default-exported', `export function xdeck(): any { return (globalThis as any).xdeck; }\nexport default xdeck;`]
    ])('the accessor %s is a finding', (_shape, src) => {
      expect(reasons(src)).toEqual([expect.stringMatching(/^the runtime accessor `xdeck` used as a value — /)]);
    });

    it('the accessor probed or re-exported under its own name is not', () => {
      expect(reasons(withAccessor(`if (typeof xdeck !== 'function') return;`))).toEqual([]);
      expect(reasons(`import { xdeck } from './runtime';\nexport { xdeck };`)).toEqual([]);
    });

    it.each([
      ['imported', `import { xdeck as rt } from './lib/runtime';\n${inMethod(`await rt().email.send({});`)}`],
      ['re-exported', `import { xdeck } from './runtime';\nexport { xdeck as rt };`]
    ])('the accessor %s under another name is a finding the marker cannot acknowledge', (_shape, src) => {
      const out = analyzeSource('T.ts', `// xdeck-capability-dynamic: renamed for a reason long enough\n${src}`);
      expect(out.acknowledged).toEqual([]);
      expect(out.unresolvable).toEqual([
        expect.objectContaining({ reason: expect.stringMatching(/^the runtime accessor `xdeck` renamed to `rt` — /) })
      ]);
    });

    it('a type-only rename has no runtime meaning', () => {
      expect(reasons(`import type { xdeck as X } from './lib/runtime';\nexport type Y = X;`)).toEqual([]);
      // The inline modifier, on an import and on a re-export, is type-only too.
      expect(reasons(`import { type xdeck as X } from './lib/runtime';\nexport type Y = X;`)).toEqual([]);
      expect(reasons(`export { type xdeck as X } from './lib/runtime';`)).toEqual([]);
    });

    it('the accessor reached through a namespace import is a finding', () => {
      expect(
        reasons(`import * as rt from './lib/runtime';\n${inMethod(`await rt.xdeck().email.send({});`)}`)
      ).toContainEqual(expect.stringMatching(/^the runtime accessor reached through the namespace import `rt` — /));
    });
  });
});
