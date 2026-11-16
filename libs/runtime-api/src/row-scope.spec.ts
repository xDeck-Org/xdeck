import {
  StaticRowScopePolicyResolver,
  applyRowScope,
  type RowScopeConstraint,
  type StaticEntityRowScopePolicy
} from './row-scope';

/**
 * §9.91.2 PR-3 — the pure row-scope primitive's contract. Load-bearing: scope is
 * a FLOOR (caller can narrow, never widen → scope wins on collision), and a
 * classified entity whose scope can't be derived fails CLOSED to `'none'` (deny
 * all rows), never the unscoped set.
 */
describe('row-scope (§9.91.2 PR-3 row-scope WHERE injection)', () => {
  describe('applyRowScope', () => {
    it("'all' returns the caller where unchanged", () => {
      expect(applyRowScope({ status: 'active' }, 'all')).toEqual({ status: 'active' });
      expect(applyRowScope(undefined, 'all')).toBeUndefined();
    });

    it('undefined caller where → the scope alone (a fresh object)', () => {
      const scope: RowScopeConstraint = { clinicianId: 'me' };
      const out = applyRowScope(undefined, scope);
      expect(out).toEqual({ clinicianId: 'me' });
      expect(out).not.toBe(scope); // defensive copy, not the resolver's object
    });

    it('object where → merged; SCOPE WINS on a key collision (caller cannot widen)', () => {
      const out = applyRowScope({ status: 'active', clinicianId: 'someoneElse' }, { clinicianId: 'me' });
      expect(out).toEqual({ status: 'active', clinicianId: 'me' });
    });

    it('array where (OR) → scope is ANDed into EVERY branch (no branch escapes)', () => {
      const out = applyRowScope([{ status: 'active' }, { status: 'pending' }], { clinicianId: 'me' });
      expect(out).toEqual([
        { status: 'active', clinicianId: 'me' },
        { status: 'pending', clinicianId: 'me' }
      ]);
    });

    it('does not mutate the caller where', () => {
      const where = { status: 'active' };
      applyRowScope(where, { clinicianId: 'me' });
      expect(where).toEqual({ status: 'active' });
    });
  });

  describe('StaticRowScopePolicyResolver', () => {
    const policy: StaticEntityRowScopePolicy = {
      rules: {
        // admins see everything
        'admin|*': 'all',
        // a clinician sees their own panel
        'clinician|*': { columns: { assignedClinicianId: { fromActorId: true } } },
        // outlet staff are scoped to their outlet attribute
        'outlet-staff|*': { columns: { outletId: { fromAttribute: 'outletId' } } },
        // an explicit lockout
        'banned|*': 'none'
      }
    };
    const resolver = new StaticRowScopePolicyResolver(new Map([['Patient', policy]]));

    it('UNCLASSIFIED entity → all (unscoped, opt-in)', () => {
      expect(resolver.resolveRowScope({ entityType: 'Invoice', actorRole: 'x', purpose: 'y' })).toEqual({
        scope: 'all'
      });
    });

    it("matched 'all' rule → all", () => {
      expect(resolver.resolveRowScope({ entityType: 'Patient', actorRole: 'admin', purpose: 'ops' })).toEqual({
        scope: 'all'
      });
    });

    it("matched 'none' rule → none (deny)", () => {
      expect(resolver.resolveRowScope({ entityType: 'Patient', actorRole: 'banned', purpose: 'x' })).toEqual({
        scope: 'none'
      });
    });

    it('columns fromActorId → builds the predicate from the actor id', () => {
      const d = resolver.resolveRowScope({
        entityType: 'Patient',
        actorRole: 'clinician',
        purpose: 'treatment',
        actorId: 'clin-1'
      });
      expect(d.scope).toEqual({ assignedClinicianId: 'clin-1' });
    });

    it('FAIL CLOSED: fromActorId but actorId is null → none', () => {
      const d = resolver.resolveRowScope({
        entityType: 'Patient',
        actorRole: 'clinician',
        purpose: 'treatment',
        actorId: null
      });
      expect(d.scope).toBe('none');
    });

    it('columns fromAttribute → builds from a session attribute', () => {
      const d = resolver.resolveRowScope({
        entityType: 'Patient',
        actorRole: 'outlet-staff',
        purpose: 'ops',
        actorAttributes: { outletId: 'out-7' }
      });
      expect(d.scope).toEqual({ outletId: 'out-7' });
    });

    it('FAIL CLOSED: fromAttribute but the attribute is absent → none', () => {
      const d = resolver.resolveRowScope({ entityType: 'Patient', actorRole: 'outlet-staff', purpose: 'ops' });
      expect(d.scope).toBe('none');
    });

    it('FAIL CLOSED: classified entity, no matching rule → none', () => {
      const d = resolver.resolveRowScope({ entityType: 'Patient', actorRole: 'stranger', purpose: 'snoop' });
      expect(d.scope).toBe('none');
    });

    it('FAIL CLOSED under prototype pollution — an inherited rule key cannot satisfy a classified miss', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (Object.prototype as any)['*|*'] = 'all';
      try {
        const d = resolver.resolveRowScope({ entityType: 'Patient', actorRole: 'stranger', purpose: 'snoop' });
        expect(d.scope).toBe('none'); // own-property guard → polluted key ignored
      } finally {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        delete (Object.prototype as any)['*|*'];
      }
    });

    it('FAIL CLOSED: an empty columns rule constrains nothing → none', () => {
      const r = new StaticRowScopePolicyResolver(new Map([['Patient', { rules: { 'clinician|*': { columns: {} } } }]]));
      expect(
        r.resolveRowScope({ entityType: 'Patient', actorRole: 'clinician', purpose: 'x', actorId: 'c1' }).scope
      ).toBe('none');
    });

    it('returns a FRESH decision each call — mutating one cannot poison a later deny (no shared sentinel)', () => {
      const q = { entityType: 'Patient', actorRole: 'banned', purpose: 'x' };
      const first = resolver.resolveRowScope(q);
      expect(first.scope).toBe('none');
      first.scope = 'all'; // adversarial reassignment of a returned decision
      const second = resolver.resolveRowScope(q);
      expect(second.scope).toBe('none'); // unpoisoned
      expect(second).not.toBe(first);
    });

    it('most-specific role|purpose wins over the wildcard fallback', () => {
      const r = new StaticRowScopePolicyResolver(
        new Map([
          [
            'Patient',
            {
              rules: {
                'clinician|treatment': { columns: { assignedClinicianId: { fromActorId: true } } },
                'clinician|*': 'none'
              }
            }
          ]
        ])
      );
      expect(
        r.resolveRowScope({ entityType: 'Patient', actorRole: 'clinician', purpose: 'treatment', actorId: 'c1' }).scope
      ).toEqual({
        assignedClinicianId: 'c1'
      });
      expect(
        r.resolveRowScope({ entityType: 'Patient', actorRole: 'clinician', purpose: 'research', actorId: 'c1' }).scope
      ).toBe('none');
    });

    describe('§9.91.8 row-union (multi-role actors)', () => {
      const q = (over: Record<string, unknown> = {}) => ({
        entityType: 'Patient',
        actorRole: null,
        purpose: 'treatment',
        actorId: 'c1',
        actorAttributes: { outletId: 'out-9' },
        ...over
      });

      it('two hats OR their scopes — each alternative one hat’s COMPLETE floor', () => {
        const d = resolver.resolveRowScope(q({ actorRoles: ['clinician', 'outlet-staff'] }));
        expect(d.scope).toEqual([{ assignedClinicianId: 'c1' }, { outletId: 'out-9' }]);
      });

      it("any hat resolving 'all' lifts the constraint entirely", () => {
        const d = resolver.resolveRowScope(q({ actorRoles: ['clinician', 'admin'] }));
        expect(d.scope).toBe('all');
      });

      it("a 'none'/unknown hat contributes nothing; a single surviving hat collapses to its object", () => {
        const banned = resolver.resolveRowScope(q({ actorRoles: ['banned', 'clinician'] }));
        expect(banned.scope).toEqual({ assignedClinicianId: 'c1' });
        const unknown = resolver.resolveRowScope(q({ actorRoles: ['auditor', 'clinician'] }));
        expect(unknown.scope).toEqual({ assignedClinicianId: 'c1' });
      });

      it("NO hat deriving a scope stays 'none' — the union never fails open", () => {
        const d = resolver.resolveRowScope(q({ actorRoles: ['auditor', 'banned'] }));
        expect(d.scope).toBe('none');
      });

      it('a hat whose source is missing fails ITS alternative closed, not the whole union', () => {
        const d = resolver.resolveRowScope(
          q({ actorRoles: ['clinician', 'outlet-staff'], actorAttributes: {} }) // outletId missing
        );
        expect(d.scope).toEqual({ assignedClinicianId: 'c1' });
      });

      it('actorRoles absent ⇒ byte-identical single-actorRole behaviour', () => {
        const single = resolver.resolveRowScope(q({ actorRole: 'clinician' }));
        const listed = resolver.resolveRowScope(q({ actorRoles: ['clinician'] }));
        expect(single.scope).toEqual({ assignedClinicianId: 'c1' });
        expect(listed.scope).toEqual(single.scope);
      });
    });

    describe('§9.91.8 applyRowScope with OR-alternative scopes', () => {
      const ALTS = [{ assignedClinicianId: 'c1' }, { outletId: 'out-9' }];

      it('no caller where → the alternatives verbatim (an OR where)', () => {
        expect(applyRowScope(undefined, ALTS)).toEqual(ALTS);
      });

      it('caller where distributes into EVERY alternative, scope-last per branch', () => {
        expect(applyRowScope({ active: true, outletId: 'spoofed' }, ALTS)).toEqual([
          { active: true, outletId: 'spoofed', assignedClinicianId: 'c1' },
          { active: true, outletId: 'out-9' } // the scope overrode the spoof in ITS branch
        ]);
      });

      it('caller OR-branches cross-product with the alternatives — no branch escapes any floor', () => {
        const result = applyRowScope([{ a: 1 }, { b: 2 }], ALTS);
        expect(result).toEqual([
          { a: 1, assignedClinicianId: 'c1' },
          { a: 1, outletId: 'out-9' },
          { b: 2, assignedClinicianId: 'c1' },
          { b: 2, outletId: 'out-9' }
        ]);
      });

      it('a single alternative collapses to a plain object (the pre-union shape)', () => {
        expect(applyRowScope({ active: true }, [{ assignedClinicianId: 'c1' }])).toEqual({
          active: true,
          assignedClinicianId: 'c1'
        });
      });
    });
  });
});
