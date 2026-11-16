import {
  StaticWritePolicyResolver,
  evaluateWriteDecision,
  type StaticEntityWritePolicy,
  type WritePolicyQuery,
  type WriteDecision
} from './write-policy';

/**
 * §9.94 B1 (ADR-0019 D5/D6) — the pure write-policy primitive's contract. The
 * load-bearing asymmetry vs. field-access/row-scope: a write policy can only
 * NARROW (the kernel gates always apply), so the UNCLASSIFIED-entity default is
 * `allow` (no-op), while a CLASSIFIED entity with no matching rule fails CLOSED
 * (deny). The two §9.91.2 PR-1 hardenings (own-property lookup, fresh decision
 * objects) are carried forward here up front.
 */
describe('write-policy (§9.94 B1 package write-policy resolver)', () => {
  const q = (over: Partial<WritePolicyQuery> = {}): WritePolicyQuery => ({
    entityType: 'Appointment',
    operation: 'update',
    actorRole: 'clinician',
    purpose: 'treatment',
    fields: { status: 'confirmed' },
    ...over
  });

  describe('StaticWritePolicyResolver', () => {
    const policy: StaticEntityWritePolicy = {
      rules: {
        // a receptionist may write, but never the clinical `diagnosis`/`notes`
        'receptionist|*': { allow: true, rejectedFields: ['diagnosis', 'notes'] },
        // a clinician may write anything the kernel floor allows
        'clinician|*': 'allow',
        // billing is locked out of this entity entirely
        'billing|*': 'deny'
      }
    };

    it('entity ABSENT from the map → allow (the no-op default; kernel gates alone govern)', () => {
      const r = new StaticWritePolicyResolver(new Map());
      expect(r.resolveWritePolicy(q({ entityType: 'AnythingUnclassified' })).effect).toBe('allow');
    });

    it('matched "allow" → allow', () => {
      const r = new StaticWritePolicyResolver(new Map([['Appointment', policy]]));
      expect(r.resolveWritePolicy(q({ actorRole: 'clinician' })).effect).toBe('allow');
    });

    it('matched "deny" → deny with a caller-safe reason', () => {
      const r = new StaticWritePolicyResolver(new Map([['Appointment', policy]]));
      const d = r.resolveWritePolicy(q({ actorRole: 'billing' }));
      expect(d.effect).toBe('deny');
      expect(d.reason).toMatch(/not permitted/i);
    });

    it('matched { allow, rejectedFields } → allow carrying the forbidden field list', () => {
      const r = new StaticWritePolicyResolver(new Map([['Appointment', policy]]));
      const d = r.resolveWritePolicy(q({ actorRole: 'receptionist' }));
      expect(d.effect).toBe('allow');
      expect(d.rejectedFields).toEqual(['diagnosis', 'notes']);
    });

    it('CLASSIFIED entity, NO matching (role,purpose) rule → fail CLOSED (deny)', () => {
      const r = new StaticWritePolicyResolver(new Map([['Appointment', policy]]));
      const d = r.resolveWritePolicy(q({ actorRole: 'auditor', purpose: 'research' }));
      expect(d.effect).toBe('deny');
    });

    it('precedence: <role>|<purpose> beats <role>|* beats *|<purpose> beats *|*', () => {
      const prec: StaticEntityWritePolicy = {
        rules: {
          'clinician|treatment': 'allow',
          'clinician|*': 'deny',
          '*|treatment': 'deny',
          '*|*': 'deny'
        }
      };
      const r = new StaticWritePolicyResolver(new Map([['Appointment', prec]]));
      expect(r.resolveWritePolicy(q({ actorRole: 'clinician', purpose: 'treatment' })).effect).toBe('allow');
    });

    it('null actorRole/purpose collapse to the `*|*` baseline rule', () => {
      const base: StaticEntityWritePolicy = { rules: { '*|*': 'allow' } };
      const r = new StaticWritePolicyResolver(new Map([['Appointment', base]]));
      expect(r.resolveWritePolicy(q({ actorRole: null, purpose: null })).effect).toBe('allow');
    });

    // ── HARDENING 1: own-property lookups only (no prototype-pollution fail-open) ──
    it('a prototype-polluted rule key cannot satisfy a classified-entity miss', () => {
      const polluted: StaticEntityWritePolicy = { rules: { 'clinician|treatment': 'allow' } };
      // Simulate a polluted Object.prototype lookup key.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (Object.prototype as any)['*|*'] = 'allow';
      try {
        const r = new StaticWritePolicyResolver(new Map([['Appointment', polluted]]));
        // auditor|audit has no OWN rule; the polluted '*|*' must NOT rescue it.
        expect(r.resolveWritePolicy(q({ actorRole: 'auditor', purpose: 'audit' })).effect).toBe('deny');
      } finally {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        delete (Object.prototype as any)['*|*'];
      }
    });

    // ── HARDENING 2: fresh decision objects (no shared mutable sentinel) ──
    it('returns a FRESH decision each call — mutating one cannot poison the next', () => {
      const r = new StaticWritePolicyResolver(new Map());
      const a = r.resolveWritePolicy(q({ entityType: 'X' }));
      a.effect = 'deny'; // a malicious/buggy consumer mutates the returned object
      const b = r.resolveWritePolicy(q({ entityType: 'X' }));
      expect(b.effect).toBe('allow'); // unaffected — not a shared sentinel
      expect(b).not.toBe(a);
    });

    it('rejectedFields is a defensive copy — mutating it cannot poison the policy', () => {
      const r = new StaticWritePolicyResolver(new Map([['Appointment', policy]]));
      const d = r.resolveWritePolicy(q({ actorRole: 'receptionist' }));
      d.rejectedFields = [...(d.rejectedFields ?? []), 'status'];
      const d2 = r.resolveWritePolicy(q({ actorRole: 'receptionist' }));
      expect(d2.rejectedFields).toEqual(['diagnosis', 'notes']);
    });
  });

  describe('evaluateWriteDecision', () => {
    it('deny → not allowed, carries the reason', () => {
      const d: WriteDecision = { effect: 'deny', reason: 'nope' };
      expect(evaluateWriteDecision(d, ['status'])).toEqual({ allowed: false, reason: 'nope' });
    });

    it('allow with no rejectedFields → allowed', () => {
      expect(evaluateWriteDecision({ effect: 'allow' }, ['status', 'amount'])).toEqual({ allowed: true });
    });

    it('allow + rejectedFields, payload touches NONE → allowed', () => {
      const d: WriteDecision = { effect: 'allow', rejectedFields: ['diagnosis'] };
      expect(evaluateWriteDecision(d, ['status'])).toEqual({ allowed: true });
    });

    it('allow + rejectedFields, payload touches SOME → LOUD refusal naming only the hit fields', () => {
      const d: WriteDecision = { effect: 'allow', rejectedFields: ['diagnosis', 'notes'] };
      const out = evaluateWriteDecision(d, ['status', 'diagnosis']);
      expect(out).toEqual({ allowed: false, forbiddenFields: ['diagnosis'] });
    });
  });
});
