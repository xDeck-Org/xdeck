import { StaticRetentionPolicyResolver, type RetentionRule } from './retention';

/**
 * §9.91.3 PR-1 — the pure retention/suppression-decision primitive's contract.
 * Load-bearing: fail-closed = PRESERVE (a classified entity whose disposition
 * can't be confidently resolved → `'suppress'`, never a silent destroy), and an
 * UNclassified entity → `'erase'` (opt-in: an empty seed is zero behaviour change
 * so telemetry keeps hard-deleting exactly as today).
 */
describe('retention (§9.91.3 PR-1 suppression-decision primitive)', () => {
  const reason = 'EHR Standards for India 2016 — patient-lifetime retention';

  it('UNCLASSIFIED entity → erase (opt-in; the zero-change default)', () => {
    const r = new StaticRetentionPolicyResolver(new Map());
    expect(r.resolveErasure({ entityType: 'TelemetryUser' })).toEqual({ disposition: 'erase', exemptionReason: null });
  });

  it('EMPTY-seeded resolver erases EVERY entity (telemetry unchanged)', () => {
    const r = new StaticRetentionPolicyResolver(new Map());
    for (const entityType of ['Patient', 'Encounter', 'Prescription', 'Whatever']) {
      expect(r.resolveErasure({ entityType }).disposition).toBe('erase');
    }
  });

  it("explicit 'erase' rule → erase", () => {
    const r = new StaticRetentionPolicyResolver(new Map<string, RetentionRule>([['TelemetryUser', 'erase']]));
    expect(r.resolveErasure({ entityType: 'TelemetryUser' })).toEqual({ disposition: 'erase', exemptionReason: null });
  });

  it('unconditional suppress rule → suppress with the exemption reason', () => {
    const r = new StaticRetentionPolicyResolver(
      new Map<string, RetentionRule>([['Patient', { suppress: { reason } }]])
    );
    expect(r.resolveErasure({ entityType: 'Patient' })).toEqual({ disposition: 'suppress', exemptionReason: reason });
  });

  describe('suppressIfFact — the active-treatment override', () => {
    const rule: RetentionRule = { suppressIfFact: 'hasActiveTreatment', reason, whenFalse: 'erase' };
    const r = new StaticRetentionPolicyResolver(new Map<string, RetentionRule>([['Encounter', rule]]));

    it('fact truthy (patient mid-care) → suppress', () => {
      expect(r.resolveErasure({ entityType: 'Encounter', facts: { hasActiveTreatment: true } })).toEqual({
        disposition: 'suppress',
        exemptionReason: reason
      });
    });

    it("fact present + explicitly false + whenFalse:'erase' → erase", () => {
      expect(r.resolveErasure({ entityType: 'Encounter', facts: { hasActiveTreatment: false } }).disposition).toBe(
        'erase'
      );
    });

    it('FAIL CLOSED: fact ABSENT → suppress (cannot confirm it is safe to erase)', () => {
      expect(r.resolveErasure({ entityType: 'Encounter', facts: {} }).disposition).toBe('suppress');
      expect(r.resolveErasure({ entityType: 'Encounter' }).disposition).toBe('suppress'); // no facts bag at all
    });

    it('FAIL CLOSED: fact present but null → suppress', () => {
      expect(r.resolveErasure({ entityType: 'Encounter', facts: { hasActiveTreatment: null } }).disposition).toBe(
        'suppress'
      );
    });

    it("whenFalse defaults to 'suppress' (fail-closed) when omitted", () => {
      const defaultRule: RetentionRule = { suppressIfFact: 'hasActiveTreatment', reason };
      const rd = new StaticRetentionPolicyResolver(new Map<string, RetentionRule>([['Encounter', defaultRule]]));
      // explicitly false, but no whenFalse → the protective default keeps it
      expect(rd.resolveErasure({ entityType: 'Encounter', facts: { hasActiveTreatment: false } }).disposition).toBe(
        'suppress'
      );
    });
  });

  it('FAIL CLOSED under prototype pollution — an inherited falsy fact cannot DESTROY a record', () => {
    // The dangerous case: pollute the prototype with a falsy value for the fact a
    // `whenFalse:'erase'` rule keys on. Without the own-property guard, the
    // inherited `false` would look "present + falsy" → erase → a prototype-pollution
    // -induced hard delete. The guard treats it as ABSENT → fail-closed suppress.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Object.prototype as any).hasActiveTreatment = false;
    try {
      const rule: RetentionRule = { suppressIfFact: 'hasActiveTreatment', reason, whenFalse: 'erase' };
      const r = new StaticRetentionPolicyResolver(new Map<string, RetentionRule>([['Encounter', rule]]));
      // caller passes an EMPTY facts bag — the only 'hasActiveTreatment' visible is the polluted inherited one
      expect(r.resolveErasure({ entityType: 'Encounter', facts: {} }).disposition).toBe('suppress');
      expect(r.resolveErasure({ entityType: 'Encounter' }).disposition).toBe('suppress');
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (Object.prototype as any).hasActiveTreatment;
    }
  });

  it('returns a FRESH decision each call — mutating one cannot poison a later suppress (no shared sentinel)', () => {
    const r = new StaticRetentionPolicyResolver(
      new Map<string, RetentionRule>([['Patient', { suppress: { reason } }]])
    );
    const first = r.resolveErasure({ entityType: 'Patient' });
    expect(first.disposition).toBe('suppress');
    first.disposition = 'erase'; // adversarial reassignment of a returned decision
    first.exemptionReason = null;
    const second = r.resolveErasure({ entityType: 'Patient' });
    expect(second).toEqual({ disposition: 'suppress', exemptionReason: reason }); // unpoisoned
    expect(second).not.toBe(first);
  });

  it('exemptionReason is null for erase, populated for suppress', () => {
    const r = new StaticRetentionPolicyResolver(
      new Map<string, RetentionRule>([
        ['Telemetry', 'erase'],
        ['Patient', { suppress: { reason } }]
      ])
    );
    expect(r.resolveErasure({ entityType: 'Telemetry' }).exemptionReason).toBeNull();
    expect(r.resolveErasure({ entityType: 'Patient' }).exemptionReason).toBe(reason);
  });
});
