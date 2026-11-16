/**
 * §9.91.6 PR-1 — statutory-egress deny primitive.
 *
 * The hardening legs mirror the §9.91.2 adversarial-verify classes
 * (wf_2b5f8caa): prototype-pollution immunity, no shared mutable sentinel,
 * fail-loud registry construction, and no-alias redaction — plus the
 * statutory-specific contracts: the API cannot express a purpose carve-out,
 * suppressions report only present-and-stripped fields, and the statute
 * attribution rides the decision for the §9.91.1 audit.
 */

import {
  PCPNDT_2003,
  redactStatutoryFields,
  StaticStatutoryEgressDenyResolver,
  type StatutoryDenyRule
} from './statutory-egress';

const RULES: StatutoryDenyRule[] = [
  { statuteId: PCPNDT_2003, entityType: 'PrenatalImaging', field: 'fetalSex', jurisdiction: 'IN' },
  { statuteId: PCPNDT_2003, entityType: 'PrenatalImaging', field: 'fetalSexIndicators', jurisdiction: 'IN' },
  { statuteId: 'hiv-confidentiality-2017', entityType: 'LabResult', field: 'hivStatus', jurisdiction: 'IN' }
];

describe('StaticStatutoryEgressDenyResolver', () => {
  const resolver = new StaticStatutoryEgressDenyResolver(RULES);

  it('answers per entity type with the statute attribution for each denied field', () => {
    const decision = resolver.resolveDeniedFields('PrenatalImaging');
    expect([...decision.deniedFields].sort()).toEqual(['fetalSex', 'fetalSexIndicators']);
    expect(decision.statuteByField.get('fetalSex')).toBe(PCPNDT_2003);

    const lab = resolver.resolveDeniedFields('LabResult');
    expect([...lab.deniedFields]).toEqual(['hivStatus']);
    expect(lab.statuteByField.get('hivStatus')).toBe('hiv-confidentiality-2017');
  });

  it('an entity no statute speaks about yields an empty decision (additive deny-list)', () => {
    const decision = resolver.resolveDeniedFields('Encounter');
    expect(decision.deniedFields.size).toBe(0);
    expect(decision.statuteByField.size).toBe(0);
  });

  it('the resolver is keyed on entity type ALONE — no role/purpose/consent parameter exists to lift it', () => {
    // Type-level contract made observable: the method arity is 1.
    expect(StaticStatutoryEgressDenyResolver.prototype.resolveDeniedFields).toHaveLength(1);
  });

  it('hands out FRESH collections — mutating a decision can never poison the registry or another read', () => {
    const first = resolver.resolveDeniedFields('PrenatalImaging');
    (first.deniedFields as Set<string>).clear();
    (first.statuteByField as Map<string, string>).clear();

    const second = resolver.resolveDeniedFields('PrenatalImaging');
    expect(second.deniedFields.size).toBe(2);
    expect(second.statuteByField.size).toBe(2);
    expect(second.deniedFields).not.toBe(first.deniedFields);
  });

  it('is immune to prototype pollution — a polluted key neither creates nor satisfies a rule', () => {
    const polluted = Object.prototype as unknown as Record<string, unknown>;
    polluted['PollutedEntity'] = new Map([['leakedField', 'fake-statute']]);
    polluted['fetalSex'] = 'lifted';
    try {
      const fresh = new StaticStatutoryEgressDenyResolver(RULES);
      expect(fresh.resolveDeniedFields('PollutedEntity').deniedFields.size).toBe(0);
      expect(fresh.resolveDeniedFields('PrenatalImaging').deniedFields.has('fetalSex')).toBe(true);
    } finally {
      delete polluted['PollutedEntity'];
      delete polluted['fetalSex'];
    }
  });

  it('accepts JSON-parsed registry rows (the PR-5 relation shape) verbatim', () => {
    const parsed = JSON.parse(JSON.stringify(RULES)) as StatutoryDenyRule[];
    const fresh = new StaticStatutoryEgressDenyResolver(parsed);
    expect(fresh.resolveDeniedFields('PrenatalImaging').deniedFields.has('fetalSex')).toBe(true);
  });

  it('REFUSES a malformed registry row at construction — a dropped statutory rule is a silent breach', () => {
    const missing = [{ statuteId: PCPNDT_2003, entityType: 'PrenatalImaging', jurisdiction: 'IN' }];
    expect(() => new StaticStatutoryEgressDenyResolver(missing as unknown as StatutoryDenyRule[])).toThrow(
      /malformed statutory rule/
    );

    const empty = [{ statuteId: '', entityType: 'PrenatalImaging', field: 'fetalSex', jurisdiction: 'IN' }];
    expect(() => new StaticStatutoryEgressDenyResolver(empty)).toThrow(/'statuteId'/);

    const inherited = Object.create({
      statuteId: PCPNDT_2003,
      entityType: 'PrenatalImaging',
      field: 'fetalSex',
      jurisdiction: 'IN'
    }) as StatutoryDenyRule;
    expect(() => new StaticStatutoryEgressDenyResolver([inherited])).toThrow(/malformed statutory rule/);
  });

  it('first statute registered for a field wins attribution; the denial is identical either way', () => {
    const overlapping = new StaticStatutoryEgressDenyResolver([
      ...RULES,
      { statuteId: 'later-statute', entityType: 'PrenatalImaging', field: 'fetalSex', jurisdiction: 'IN' }
    ]);
    const decision = overlapping.resolveDeniedFields('PrenatalImaging');
    expect(decision.statuteByField.get('fetalSex')).toBe(PCPNDT_2003);
    expect(decision.deniedFields.has('fetalSex')).toBe(true);
  });
});

describe('redactStatutoryFields', () => {
  const resolver = new StaticStatutoryEgressDenyResolver(RULES);

  const ROWS = [
    { id: 'img-1', gestationalAgeWeeks: 22, fetalSex: 'redact-me', findings: 'normal scan' },
    { id: 'img-2', gestationalAgeWeeks: 30, findings: 'follow-up' },
    { id: 'img-3', gestationalAgeWeeks: 18, fetalSex: 'redact-me-too', fetalSexIndicators: 'redact-3' }
  ];

  it('strips denied fields that are PRESENT, omitting (not nulling) them', () => {
    const result = redactStatutoryFields(ROWS, 'PrenatalImaging', resolver);
    expect(result.rows[0]).toEqual({ id: 'img-1', gestationalAgeWeeks: 22, findings: 'normal scan' });
    expect(result.rows[0]).not.toHaveProperty('fetalSex');
    expect(result.rows[2]).toEqual({ id: 'img-3', gestationalAgeWeeks: 18 });
    expect(JSON.stringify(result.rows)).not.toContain('redact');
  });

  it('reports present-and-stripped suppressions deduped, with statute attribution + affected count', () => {
    const result = redactStatutoryFields(ROWS, 'PrenatalImaging', resolver);
    expect(result.suppressions.sort((a, b) => a.field.localeCompare(b.field))).toEqual([
      { field: 'fetalSex', statuteId: PCPNDT_2003 },
      { field: 'fetalSexIndicators', statuteId: PCPNDT_2003 }
    ]);
    expect(result.affectedRowCount).toBe(2);
  });

  it('a rule whose field no row carries reports NO suppression (present-and-stripped, never rule-existed)', () => {
    const result = redactStatutoryFields([{ id: 'img-9', findings: 'clean' }], 'PrenatalImaging', resolver);
    expect(result.suppressions).toEqual([]);
    expect(result.affectedRowCount).toBe(0);
  });

  it('never mutates or aliases an affected input row; unaffected rows pass by reference', () => {
    const result = redactStatutoryFields(ROWS, 'PrenatalImaging', resolver);
    expect(ROWS[0]).toHaveProperty('fetalSex', 'redact-me');
    expect(result.rows[0]).not.toBe(ROWS[0]);
    expect(result.rows[1]).toBe(ROWS[1]);
  });

  it('an entity with no denials is a zero-copy identity pass', () => {
    const rows = [{ id: 'e-1', statusId: 's-1' }];
    const result = redactStatutoryFields(rows, 'Encounter', resolver);
    expect(result.rows).toBe(rows);
    expect(result.suppressions).toEqual([]);
  });

  it('composes as the floor UNDER a fail-open field-ABAC decision — the denied field is stripped even from an unmasked row set', () => {
    // Models the §9.91.2 'all' (misconfigured/absent resolver) case: the ABAC
    // layer passes everything; the statutory floor still holds.
    const unmaskedByAbac = ROWS;
    const result = redactStatutoryFields(unmaskedByAbac, 'PrenatalImaging', resolver);
    expect(JSON.stringify(result.rows)).not.toContain('fetalSex');
  });
});
