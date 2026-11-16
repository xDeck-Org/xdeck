import {
  StaticFieldAccessPolicyResolver,
  projectVisibleFields,
  projectRows,
  type FieldAccessDecision,
  type StaticEntityFieldPolicy
} from './field-access';

/**
 * §9.91.2 PR-1 — the pure field-ABAC primitive's contract. The load-bearing
 * assertions are (1) an UNCLASSIFIED entity is unmasked (migration-safe, opt-in,
 * matches §9.91.1) and (2) a CLASSIFIED entity with no matching rule fails
 * CLOSED — including the `null/null` "no carrier plumbed yet" case — so the
 * read path can never leak a PHI column before PR-2 wires the session carrier.
 */
describe('field-access (§9.91.2 field-level ABAC primitive)', () => {
  describe('projectVisibleFields', () => {
    const row = { id: 'e1', patientId: 'p1', diagnosis: 'flu', medication: 'rest', updatedAt: 't' };

    it("'all' is the zero-copy identity fast path — same reference back", () => {
      const decision: FieldAccessDecision = { visibleFields: 'all' };
      expect(projectVisibleFields(row, decision)).toBe(row);
    });

    it('projects ONLY the visible keys; a masked field is OMITTED, not nulled', () => {
      const decision: FieldAccessDecision = { visibleFields: new Set(['id', 'patientId', 'updatedAt']) };
      const out = projectVisibleFields(row, decision);

      expect(out).toEqual({ id: 'e1', patientId: 'p1', updatedAt: 't' });
      // omitted-not-nulled: the key is absent (no information about its existence/value)
      expect('diagnosis' in out).toBe(false);
      expect('medication' in out).toBe(false);
    });

    it('does not mutate the input row', () => {
      const decision: FieldAccessDecision = { visibleFields: new Set(['id']) };
      projectVisibleFields(row, decision);
      expect(row).toEqual({ id: 'e1', patientId: 'p1', diagnosis: 'flu', medication: 'rest', updatedAt: 't' });
    });

    it('an empty visible set (deny) yields an empty object — no columns leak', () => {
      const decision: FieldAccessDecision = { visibleFields: new Set<string>() };
      expect(projectVisibleFields(row, decision)).toEqual({});
    });

    it('visible keys absent from the row are simply not present (no undefined holes)', () => {
      const decision: FieldAccessDecision = { visibleFields: new Set(['id', 'notOnRow']) };
      const out = projectVisibleFields(row, decision);
      expect(out).toEqual({ id: 'e1' });
      expect('notOnRow' in out).toBe(false);
    });
  });

  describe('projectRows', () => {
    const rows = [
      { id: 'e1', diagnosis: 'flu' },
      { id: 'e2', diagnosis: 'cold' }
    ];

    it("'all' returns the same array reference (zero-copy)", () => {
      expect(projectRows(rows, { visibleFields: 'all' })).toBe(rows);
    });

    it('maps the projection across every row when masked', () => {
      const out = projectRows(rows, { visibleFields: new Set(['id']) });
      expect(out).toEqual([{ id: 'e1' }, { id: 'e2' }]);
    });
  });

  describe('StaticFieldAccessPolicyResolver', () => {
    const encounterPolicy: StaticEntityFieldPolicy = {
      rules: {
        // most-specific: clinician treating sees everything
        'clinician|treatment': 'all',
        // a clinician under any other purpose: clinical fields but not billing notes
        'clinician|*': new Set(['id', 'patientId', 'diagnosis', 'medication']),
        // a receptionist under any purpose: scheduling only — never the diagnosis
        'receptionist|*': new Set(['id', 'patientId', 'appointmentAt']),
        // billing under the billing purpose: identifiers + charge, no clinical detail
        '*|billing': new Set(['id', 'patientId', 'chargeAmount']),
        // entity baseline (any role, any purpose): bare identifiers
        '*|*': new Set(['id'])
      }
    };
    const resolver = new StaticFieldAccessPolicyResolver(new Map([['Encounter', encounterPolicy]]));

    it('UNCLASSIFIED entity → unmasked (all) — opt-in classification, migration-safe', () => {
      expect(resolver.resolveVisibleFields({ entityType: 'Invoice', actorRole: 'anyone', purpose: 'billing' })).toEqual(
        { visibleFields: 'all' }
      );
    });

    it('most-specific role|purpose wins (clinician|treatment → all)', () => {
      expect(
        resolver.resolveVisibleFields({ entityType: 'Encounter', actorRole: 'clinician', purpose: 'treatment' })
      ).toEqual({ visibleFields: 'all' });
    });

    it('falls back role|* when purpose has no specific rule', () => {
      const d = resolver.resolveVisibleFields({ entityType: 'Encounter', actorRole: 'clinician', purpose: 'research' });
      expect(d.visibleFields).toEqual(new Set(['id', 'patientId', 'diagnosis', 'medication']));
    });

    it('falls back *|purpose when the role has no rule (billing clerk under billing)', () => {
      const d = resolver.resolveVisibleFields({ entityType: 'Encounter', actorRole: 'finance', purpose: 'billing' });
      expect(d.visibleFields).toEqual(new Set(['id', 'patientId', 'chargeAmount']));
    });

    it('receptionist never sees diagnosis/medication under any purpose', () => {
      const d = resolver.resolveVisibleFields({
        entityType: 'Encounter',
        actorRole: 'receptionist',
        purpose: 'treatment'
      });
      const set = d.visibleFields as ReadonlySet<string>;
      expect(set.has('diagnosis')).toBe(false);
      expect(set.has('medication')).toBe(false);
      expect(set.has('appointmentAt')).toBe(true);
    });

    it('falls back to the *|* baseline for an unknown role+purpose that still has a baseline', () => {
      const d = resolver.resolveVisibleFields({ entityType: 'Encounter', actorRole: 'janitor', purpose: 'curiosity' });
      expect(d.visibleFields).toEqual(new Set(['id']));
    });

    it('CLASSIFIED entity with NO baseline + no match → FAIL CLOSED (deny, empty set)', () => {
      const noBaseline = new StaticFieldAccessPolicyResolver(
        new Map([['Encounter', { rules: { 'clinician|treatment': 'all' } }]])
      );
      const d = noBaseline.resolveVisibleFields({
        entityType: 'Encounter',
        actorRole: 'stranger',
        purpose: 'snooping'
      });
      expect(d.visibleFields).toEqual(new Set());
    });

    it('FAIL CLOSED on the null/null "no carrier plumbed yet" case for a classified entity (no baseline)', () => {
      const noBaseline = new StaticFieldAccessPolicyResolver(
        new Map([['Encounter', { rules: { 'clinician|treatment': 'all' } }]])
      );
      const d = noBaseline.resolveVisibleFields({ entityType: 'Encounter', actorRole: null, purpose: null });
      expect(d.visibleFields).toEqual(new Set());
    });

    it('null role/purpose resolve through the * wildcards to the baseline when one exists', () => {
      const d = resolver.resolveVisibleFields({ entityType: 'Encounter', actorRole: null, purpose: null });
      expect(d.visibleFields).toEqual(new Set(['id']));
    });

    // ── fail-closed hardenings (adversarial-verify wf_2b5f8caa) ────────────

    it('FAIL CLOSED under prototype pollution — an inherited `*|*` key cannot satisfy a classified miss', () => {
      const noBaseline = new StaticFieldAccessPolicyResolver(
        new Map([
          ['Encounter', { rules: { 'clinician|treatment': 'all' } as Record<string, ReadonlySet<string> | 'all'> }]
        ])
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (Object.prototype as any)['*|*'] = 'all';
      try {
        const d = noBaseline.resolveVisibleFields({ entityType: 'Encounter', actorRole: 'stranger', purpose: 'snoop' });
        // own-property guard → the polluted inherited key is NOT honoured → deny.
        expect(d.visibleFields).toEqual(new Set());
      } finally {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        delete (Object.prototype as any)['*|*'];
      }
    });

    it('each deny returns a FRESH set — mutating one decision cannot poison a later deny (no shared sentinel)', () => {
      const noBaseline = new StaticFieldAccessPolicyResolver(
        new Map([
          ['Encounter', { rules: { 'clinician|treatment': 'all' } as Record<string, ReadonlySet<string> | 'all'> }]
        ])
      );
      const q = { entityType: 'Encounter', actorRole: 'stranger', purpose: 'snoop' };
      const first = noBaseline.resolveVisibleFields(q);
      (first.visibleFields as Set<string>).add('diagnosis'); // adversarial mutation
      const second = noBaseline.resolveVisibleFields(q);
      expect(second.visibleFields).toEqual(new Set()); // unpoisoned
      expect(second.visibleFields).not.toBe(first.visibleFields);
    });

    it('a matched set is a defensive COPY — mutating it does not corrupt the policy for later reads', () => {
      const q = { entityType: 'Encounter', actorRole: 'receptionist', purpose: 'treatment' };
      const first = resolver.resolveVisibleFields(q);
      (first.visibleFields as Set<string>).add('diagnosis'); // adversarial mutation of a returned decision
      const second = resolver.resolveVisibleFields(q);
      expect((second.visibleFields as ReadonlySet<string>).has('diagnosis')).toBe(false);
      expect(second.visibleFields).toEqual(new Set(['id', 'patientId', 'appointmentAt']));
    });

    describe('§9.91.8 PR-4b — union-across-roles (multi-role actors)', () => {
      it('unions each role’s grant — a two-hat actor sees what either hat may see, nothing more', () => {
        const d = resolver.resolveVisibleFields({
          entityType: 'Encounter',
          actorRole: null,
          actorRoles: ['clinician', 'receptionist'],
          purpose: 'research'
        });
        expect(d.visibleFields).toEqual(new Set(['id', 'patientId', 'diagnosis', 'medication', 'appointmentAt']));
      });

      it("any role resolving 'all' lifts the mask for the union", () => {
        const d = resolver.resolveVisibleFields({
          entityType: 'Encounter',
          actorRole: null,
          actorRoles: ['receptionist', 'clinician'],
          purpose: 'treatment'
        });
        expect(d).toEqual({ visibleFields: 'all' });
      });

      it('ORDER-INDEPENDENT — reversed role lists resolve to the identical set (the PR-4a determinism promise)', () => {
        const forward = resolver.resolveVisibleFields({
          entityType: 'Encounter',
          actorRole: null,
          actorRoles: ['clinician', 'receptionist'],
          purpose: 'research'
        });
        const reversed = resolver.resolveVisibleFields({
          entityType: 'Encounter',
          actorRole: null,
          actorRoles: ['receptionist', 'clinician'],
          purpose: 'research'
        });
        expect(forward.visibleFields).toEqual(reversed.visibleFields);
      });

      it('an unknown role contributes only the entity baseline — the union never invents a grant', () => {
        const d = resolver.resolveVisibleFields({
          entityType: 'Encounter',
          actorRole: null,
          actorRoles: ['auditor', 'receptionist'],
          purpose: 'scheduling'
        });
        // auditor falls through to the '*|*' baseline {id}; receptionist adds its set.
        expect(d.visibleFields).toEqual(new Set(['id', 'patientId', 'appointmentAt']));
      });

      it('actorRoles absent ⇒ byte-identical to the single-actorRole path (no behaviour change for existing callers)', () => {
        const single = resolver.resolveVisibleFields({
          entityType: 'Encounter',
          actorRole: 'receptionist',
          purpose: 'scheduling'
        });
        const listed = resolver.resolveVisibleFields({
          entityType: 'Encounter',
          actorRole: null,
          actorRoles: ['receptionist'],
          purpose: 'scheduling'
        });
        expect(single.visibleFields).toEqual(listed.visibleFields);
      });

      it('the union set is FRESH — the no-shared-sentinel hardening holds on the multi-role path too', () => {
        const q = {
          entityType: 'Encounter',
          actorRole: null,
          actorRoles: ['auditor', 'receptionist'],
          purpose: 'scheduling'
        };
        const first = resolver.resolveVisibleFields(q);
        (first.visibleFields as Set<string>).add('diagnosis');
        const second = resolver.resolveVisibleFields(q);
        expect((second.visibleFields as ReadonlySet<string>).has('diagnosis')).toBe(false);
      });
    });
  });
});
