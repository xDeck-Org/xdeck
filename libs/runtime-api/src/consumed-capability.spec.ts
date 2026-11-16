/**
 * §9.94 B5.b (ADR-0019 D9.2) — consumed-capability grammar spec. The consumer half: a
 * `<ns>:<name>@<range>` dependency on another package's capability, kernel-wins enforced
 * (a package consumes another PACKAGE's capability, never a kernel one).
 */

import {
  parseConsumedCapability,
  validateConsumedCapability,
  consumedCapabilityName,
  type ConsumedCapability
} from './consumed-capability';

describe('consumed-capability grammar (§9.94 B5.b)', () => {
  describe('parseConsumedCapability — carries the RANGE raw', () => {
    it.each([
      ['caret', 'restroin:menu-lookup@^1.0.0', { namespace: 'restroin', name: 'menu-lookup', range: '^1.0.0' }],
      ['tilde', 'restroin:menu-lookup@~1.2.0', { namespace: 'restroin', name: 'menu-lookup', range: '~1.2.0' }],
      ['wildcard', 'clinic:triage@*', { namespace: 'clinic', name: 'triage', range: '*' }],
      ['compound', 'clinic:triage@>=1.0.0 <2.0.0', { namespace: 'clinic', name: 'triage', range: '>=1.0.0 <2.0.0' }],
      ['exact', 'restroin:order-status@1.0.0', { namespace: 'restroin', name: 'order-status', range: '1.0.0' }]
    ])('parses %s', (_l, input, expected) => {
      expect(parseConsumedCapability(input)).toEqual(expected);
    });

    it.each([
      ['no range', 'restroin:menu-lookup'],
      ['empty range', 'restroin:menu-lookup@'],
      ['no name', 'restroin@^1.0.0'],
      ['two colons', 'restroin:menu:lookup@^1.0.0'],
      ['two @', 'restroin:menu@1@2'],
      ['uppercase', 'Restroin:menu@^1.0.0'],
      ['empty', '']
    ])('rejects malformed (%s)', (_l, input) => {
      expect(parseConsumedCapability(input)).toBeNull();
    });
  });

  describe('validateConsumedCapability — D9.3 kernel-wins', () => {
    it('accepts a non-kernel package capability', () => {
      expect(validateConsumedCapability('restroin:menu-lookup@^1.0.0')).toEqual({
        ok: true,
        parsed: { namespace: 'restroin', name: 'menu-lookup', range: '^1.0.0' }
      });
    });

    it('rejects malformed with reason `malformed`', () => {
      expect(validateConsumedCapability('garbage')).toEqual({ ok: false, reason: 'malformed' });
    });

    it.each([['email'], ['entity'], ['class'], ['secret'], ['telemetry']])(
      'rejects consuming the KERNEL namespace `%s` (use capabilities.required instead)',
      (ns) => {
        expect(validateConsumedCapability(`${ns}:x@^1.0.0`)).toEqual({ ok: false, reason: 'kernel_namespace' });
      }
    );
  });

  it('consumedCapabilityName drops the range (the provider-match key)', () => {
    const cap: ConsumedCapability = { namespace: 'restroin', name: 'menu-lookup', range: '^1.0.0' };
    expect(consumedCapabilityName(cap)).toBe('restroin:menu-lookup');
  });
});
