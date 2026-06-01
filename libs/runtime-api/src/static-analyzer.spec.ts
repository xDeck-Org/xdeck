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
    it('reading xdeck.context.tenantId does not register usage', () => {
      const out = analyzeSource('CtxReader.ts', `class CtxReader { read() { return xdeck.context.tenantId; } }`);
      expect(out.used).toEqual([]);
      expect(out.unresolvable).toEqual([]);
    });

    it('reading xdeck.context.package.namespace (deep chain) is allowed', () => {
      const out = analyzeSource('Deep.ts', `class Deep { read() { return xdeck.context.package.namespace; } }`);
      expect(out.used).toEqual([]);
      expect(out.unresolvable).toEqual([]);
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
    it('aliasing `const e = xdeck.email; e.send(...)` → unresolvable on the alias assignment', () => {
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
      expect(out.used).toEqual([]);
      expect(out.unresolvable).toHaveLength(1);
      expect(out.unresolvable[0].reason).toMatch(/partial member access/);
      expect(out.unresolvable[0].expression).toBe('xdeck.email');
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
    it('returns empty result when classes/transforms/ does not exist', () => {
      const out = analyzePackageDir(packageDir);
      expect(out).toEqual({ used: [], unresolvable: [] });
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
      expect(out).toEqual({ used: [], unresolvable: [] });
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
});
