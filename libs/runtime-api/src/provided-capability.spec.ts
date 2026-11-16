/**
 * §9.94 B5.a (ADR-0019 D9) — provided-capability grammar spec. Pins the contract the
 * publish gate + registry + broker all depend on: the `<ns>:<name>@<semver>` shape, and
 * the D9.3 KERNEL-WINS rule (a package can never declare a capability that shadows a kernel
 * namespace — no hijacking `email:send`).
 */

import {
  parseProvidedCapability,
  validateProvidedCapability,
  validateProvidedCapabilityEntry,
  formatProvidedCapability,
  providedCapabilityName,
  providedCapabilityId,
  normalizeProvidedCapability,
  clampAiExecution,
  resolveCapabilityPolicies,
  KERNEL_CAPABILITY_NAMESPACES,
  type ProvidedCapability,
  type NormalizedProvidedCapability
} from './provided-capability';
import {
  BILLING_GATEWAY_CAPABILITY,
  CONSUMER_IDENTITY_PROVIDER_CAPABILITY,
  GRANTABLE_STATIC_CAPABILITIES,
  HEALTH_RECORD_EXCHANGE_CAPABILITY,
  IOT_DEVICE_PLANE_CAPABILITY,
  RESERVED_CAPABILITY_FAMILIES
} from './capability';
import * as runtimeApiIndex from './index';

describe('provided-capability grammar (§9.94 B5.a)', () => {
  describe('parseProvidedCapability', () => {
    it('parses a well-formed `<ns>:<name>@<semver>`', () => {
      expect(parseProvidedCapability('restroin:menu-lookup@1.0.0')).toEqual({
        namespace: 'restroin',
        name: 'menu-lookup',
        version: '1.0.0'
      });
    });

    it('accepts prerelease + build metadata in the version', () => {
      expect(parseProvidedCapability('clinic:triage@2.1.0-rc.1+build.7')).toEqual({
        namespace: 'clinic',
        name: 'triage',
        version: '2.1.0-rc.1+build.7'
      });
    });

    it.each([
      ['no version', 'restroin:menu-lookup'],
      ['no name', 'restroin@1.0.0'],
      ['two @', 'restroin:x@1.0.0@2'],
      ['two : in head', 'restroin:menu:lookup@1.0.0'],
      ['range not concrete', 'restroin:menu-lookup@^1.0.0'],
      ['partial version', 'restroin:menu-lookup@1.0'],
      ['uppercase namespace', 'Restroin:menu@1.0.0'],
      ['leading digit namespace', '1restroin:menu@1.0.0'],
      ['empty', ''],
      ['underscore', 'restro_in:menu@1.0.0']
    ])('rejects malformed input (%s)', (_label, input) => {
      expect(parseProvidedCapability(input)).toBeNull();
    });
  });

  describe('validateProvidedCapability — D9.3 kernel-wins', () => {
    it('accepts a non-kernel namespace', () => {
      expect(validateProvidedCapability('restroin:menu-lookup@1.0.0')).toEqual({
        ok: true,
        parsed: { namespace: 'restroin', name: 'menu-lookup', version: '1.0.0' }
      });
    });

    it('rejects malformed strings with reason `malformed`', () => {
      expect(validateProvidedCapability('not a cap')).toEqual({ ok: false, reason: 'malformed' });
    });

    it.each([['email'], ['entity'], ['class'], ['secret'], ['route'], ['ai'], ['telemetry'], ['binding'], ['iot']])(
      'rejects the reserved KERNEL namespace `%s` (cannot shadow a kernel capability)',
      (ns) => {
        expect(validateProvidedCapability(`${ns}:anything@1.0.0`)).toEqual({ ok: false, reason: 'kernel_namespace' });
      }
    );

    it('rejects EVERY kernel namespace derived from the catalogue (stays in lockstep)', () => {
      for (const ns of KERNEL_CAPABILITY_NAMESPACES) {
        expect(validateProvidedCapability(`${ns}:x@1.0.0`).ok).toBe(false);
      }
    });
  });

  describe('KERNEL_CAPABILITY_NAMESPACES is derived from the live catalogue', () => {
    it('contains the namespace of every grantable static capability', () => {
      for (const cap of GRANTABLE_STATIC_CAPABILITIES) {
        expect(KERNEL_CAPABILITY_NAMESPACES.has(cap.slice(0, cap.indexOf(':')))).toBe(true);
      }
    });

    it('contains the reserved `class` (broker hook) namespace', () => {
      // RESERVED_CAPABILITY_FAMILIES = ['class:invoke'] → namespace 'class' is reserved,
      // so a package can never provide `class:*` (the broker owns cross-package invocation).
      expect(RESERVED_CAPABILITY_FAMILIES.some((f) => f.startsWith('class:'))).toBe(true);
      expect(KERNEL_CAPABILITY_NAMESPACES.has('class')).toBe(true);
    });
  });

  describe('format / name round-trips', () => {
    const cap: ProvidedCapability = { namespace: 'restroin', name: 'menu-lookup', version: '1.0.0' };
    it('formatProvidedCapability is the inverse of parse', () => {
      expect(formatProvidedCapability(cap)).toBe('restroin:menu-lookup@1.0.0');
      expect(parseProvidedCapability(formatProvidedCapability(cap))).toEqual(cap);
    });
    it('providedCapabilityName drops the version (the range-binding key)', () => {
      expect(providedCapabilityName(cap)).toBe('restroin:menu-lookup');
    });
  });

  // §9.52.15 A2 — the descriptor form + AI-execution policy.
  describe('A2 descriptor + AI-execution policy', () => {
    it('providedCapabilityId extracts the id from either entry form', () => {
      expect(providedCapabilityId('restroin:place-order@1.0.0')).toBe('restroin:place-order@1.0.0');
      expect(providedCapabilityId({ id: 'restroin:place-order@1.0.0', description: 'x' })).toBe(
        'restroin:place-order@1.0.0'
      );
    });

    it('normalizes a BARE string to SAFE defaults (aiExecution forbidden, not mutating, no description)', () => {
      expect(normalizeProvidedCapability('restroin:place-order@1.0.0')).toEqual({
        namespace: 'restroin',
        name: 'place-order',
        version: '1.0.0',
        description: null,
        mutates: false,
        aiExecution: 'forbidden',
        touchesSettings: false
      });
    });

    it('normalizes a descriptor, carrying its metadata (and trimming the description)', () => {
      expect(
        normalizeProvidedCapability({
          id: 'restroin:place-order@1.0.0',
          description: '  Place a customer order.  ',
          mutates: true,
          aiExecution: 'draft',
          touchesSettings: false
        })
      ).toEqual({
        namespace: 'restroin',
        name: 'place-order',
        version: '1.0.0',
        description: 'Place a customer order.',
        mutates: true,
        aiExecution: 'draft',
        touchesSettings: false
      });
    });

    it('defaults an UNKNOWN aiExecution value to forbidden (fail-closed)', () => {
      const n = normalizeProvidedCapability({ id: 'restroin:x@1.0.0', aiExecution: 'yolo' as never });
      expect(n?.aiExecution).toBe('forbidden');
    });

    it('returns null for an invalid id grammar in either form', () => {
      expect(normalizeProvidedCapability('not a cap')).toBeNull();
      expect(normalizeProvidedCapability({ id: 'restroin:x' })).toBeNull(); // no @version
    });

    describe('clampAiExecution — tenant can only TIGHTEN, never escalate', () => {
      it('tightens auto→draft when the tenant requests less', () => {
        expect(clampAiExecution('auto', 'draft')).toBe('draft');
        expect(clampAiExecution('auto', 'forbidden')).toBe('forbidden');
        expect(clampAiExecution('draft', 'forbidden')).toBe('forbidden');
      });
      it('CANNOT escalate beyond the author ceiling', () => {
        expect(clampAiExecution('draft', 'auto')).toBe('draft'); // tenant wants auto, author capped draft → draft
        expect(clampAiExecution('forbidden', 'auto')).toBe('forbidden');
        expect(clampAiExecution('forbidden', 'draft')).toBe('forbidden');
      });
      it('a missing/invalid override yields the author ceiling unchanged', () => {
        expect(clampAiExecution('draft', null)).toBe('draft');
        expect(clampAiExecution('draft', undefined)).toBe('draft');
        expect(clampAiExecution('auto', 'nonsense' as never)).toBe('auto');
      });
    });

    describe('resolveCapabilityPolicies (PR3 — author ∩ tenant ∩ settings-write guard)', () => {
      const desc = (over: Partial<NormalizedProvidedCapability>): NormalizedProvidedCapability => ({
        namespace: 'restroin',
        name: 'place-order',
        version: '1.0.0',
        description: null,
        mutates: false,
        aiExecution: 'draft',
        touchesSettings: false,
        ...over
      });

      it('returns the author ceiling when there is no tenant override', () => {
        const [r] = resolveCapabilityPolicies(
          [desc({ aiExecution: 'draft', description: 'Place an order.' })],
          {},
          false
        );
        expect(r).toMatchObject({
          name: 'restroin:place-order',
          authorCeiling: 'draft',
          effectiveExecution: 'draft',
          description: 'Place an order.'
        });
      });

      it('CLAMPS to the tenant override (tighten only) — and a tenant CANNOT escalate', () => {
        const tightened = resolveCapabilityPolicies(
          [desc({ aiExecution: 'auto' })],
          { 'restroin:place-order': 'draft' },
          false
        );
        expect(tightened[0].effectiveExecution).toBe('draft'); // auto ceiling tightened to draft
        const escalated = resolveCapabilityPolicies(
          [desc({ aiExecution: 'draft' })],
          { 'restroin:place-order': 'auto' },
          false
        );
        expect(escalated[0].effectiveExecution).toBe('draft'); // tenant asked auto, author capped draft → draft
      });

      it('FORCES forbidden for a touchesSettings capability when allowSettingsWrite is OFF (regardless of clamp)', () => {
        const [r] = resolveCapabilityPolicies(
          [desc({ name: 'set-tax', aiExecution: 'auto', touchesSettings: true })],
          { 'restroin:set-tax': 'auto' },
          false
        );
        expect(r.effectiveExecution).toBe('forbidden');
      });

      it('allows a touchesSettings capability up to its clamped policy when allowSettingsWrite is ON', () => {
        const [r] = resolveCapabilityPolicies(
          [desc({ name: 'set-tax', aiExecution: 'draft', touchesSettings: true })],
          {},
          true
        );
        expect(r.effectiveExecution).toBe('draft');
      });

      it('DEDUPES a name across packages, keeping the MOST RESTRICTIVE author ceiling (fail-safe)', () => {
        const out = resolveCapabilityPolicies(
          [desc({ aiExecution: 'auto' }), desc({ aiExecution: 'forbidden' })],
          {},
          false
        );
        expect(out).toHaveLength(1);
        expect(out[0].authorCeiling).toBe('forbidden');
      });

      it('is deterministic (sorted by name) + carries mutates/description through', () => {
        const out = resolveCapabilityPolicies(
          [desc({ name: 'z-last', mutates: true }), desc({ name: 'a-first', description: 'first' })],
          {},
          true
        );
        expect(out.map((r) => r.name)).toEqual(['restroin:a-first', 'restroin:z-last']);
        expect(out[0].description).toBe('first');
        expect(out[1].mutates).toBe(true);
      });

      it('ignores an override that is not an own-property / not a valid policy (defence-in-depth)', () => {
        const overrides = Object.create({ 'restroin:place-order': 'auto' }) as Record<string, never>; // inherited, not own
        const [r] = resolveCapabilityPolicies([desc({ aiExecution: 'draft' })], overrides, false);
        expect(r.effectiveExecution).toBe('draft'); // inherited override ignored → author ceiling
      });
    });

    describe('validateProvidedCapabilityEntry', () => {
      it('accepts a valid descriptor', () => {
        expect(validateProvidedCapabilityEntry({ id: 'restroin:place-order@1.0.0', aiExecution: 'draft' }).ok).toBe(
          true
        );
      });
      it('rejects a descriptor with an invalid aiExecution (bad_ai_execution)', () => {
        expect(
          validateProvidedCapabilityEntry({ id: 'restroin:place-order@1.0.0', aiExecution: 'yolo' as never })
        ).toEqual({
          ok: false,
          reason: 'bad_ai_execution'
        });
      });
      it('still rejects a kernel-namespace id in descriptor form (D9.3 kernel-wins holds)', () => {
        expect(validateProvidedCapabilityEntry({ id: 'email:send@1.0.0' })).toEqual({
          ok: false,
          reason: 'kernel_namespace'
        });
      });
    });
  });
});

// §9.80 — the billing:gateway payment-gateway SOCKET. These receipts pin why
// the canonical name is what it is: the slice's original dot-form was
// ungrammatical (undeclarable + ungrantable), and the obvious alternative
// namespace is kernel-reserved.
describe('BILLING_GATEWAY_CAPABILITY — §9.80 gateway socket', () => {
  it('the canonical colon form parses and validates (declarable by vendor packages)', () => {
    expect(parseProvidedCapability(`${BILLING_GATEWAY_CAPABILITY}@1.0.0`)).toEqual({
      namespace: 'billing',
      name: 'gateway',
      version: '1.0.0'
    });
    expect(validateProvidedCapability(`${BILLING_GATEWAY_CAPABILITY}@1.0.0`)).toEqual({
      ok: true,
      parsed: { namespace: 'billing', name: 'gateway', version: '1.0.0' }
    });
  });

  it("the slice's original dot-form (`billing.gateway`) parses to null — the row-980 defect", () => {
    expect(parseProvidedCapability('billing.gateway@1.0.0')).toBeNull();
    expect(validateProvidedCapability('billing.gateway@1.0.0')).toEqual({ ok: false, reason: 'malformed' });
  });

  it('`payment:gateway` is refused by kernel-wins (payment:* is a kernel namespace) — why the socket is billing:*', () => {
    expect(validateProvidedCapability('payment:gateway@1.0.0')).toEqual({ ok: false, reason: 'kernel_namespace' });
  });
});

// §9.171 — the well-known sockets live in `./capability` (the frontend's subpath). Each must
// stay DECLARABLE by a package: a socket whose namespace became a kernel namespace would be
// refused at publish (D9.3 kernel-wins) and could never be filled.
describe('well-known capability sockets — §9.171', () => {
  it.each([BILLING_GATEWAY_CAPABILITY, IOT_DEVICE_PLANE_CAPABILITY])(
    '%s@1.0.0 validates as a provided capability',
    (socket) => {
      const result = validateProvidedCapability(`${socket}@1.0.0`);
      expect(result.ok).toBe(true);
      if (result.ok) expect(providedCapabilityName(result.parsed)).toBe(socket);
    }
  );

  it('neither socket namespace is a kernel namespace', () => {
    expect(KERNEL_CAPABILITY_NAMESPACES.has('billing')).toBe(false);
    expect(KERNEL_CAPABILITY_NAMESPACES.has('devices')).toBe(false);
  });

  it('`iot:plane` is refused by kernel-wins (iot:* is a kernel namespace) — why the device socket is devices:*', () => {
    expect(IOT_DEVICE_PLANE_CAPABILITY).toBe('devices:iot-plane');
    expect(validateProvidedCapability('iot:plane@1.0.0')).toEqual({ ok: false, reason: 'kernel_namespace' });
  });

  it('the package index still re-exports both sockets', () => {
    expect(runtimeApiIndex.BILLING_GATEWAY_CAPABILITY).toBe(BILLING_GATEWAY_CAPABILITY);
    expect(runtimeApiIndex.IOT_DEVICE_PLANE_CAPABILITY).toBe(IOT_DEVICE_PLANE_CAPABILITY);
  });
});

// §9.171 H1 — the consumer identity provider socket. Same two promises as the sockets above:
// a package can declare it, and its namespace is not a kernel one.
describe('CONSUMER_IDENTITY_PROVIDER_CAPABILITY — §9.171 H1', () => {
  it('identity:consumer-provider@1.0.0 validates as a provided capability and names the socket', () => {
    expect(CONSUMER_IDENTITY_PROVIDER_CAPABILITY).toBe('identity:consumer-provider');
    expect(parseProvidedCapability(`${CONSUMER_IDENTITY_PROVIDER_CAPABILITY}@1.0.0`)).toEqual({
      namespace: 'identity',
      name: 'consumer-provider',
      version: '1.0.0'
    });
    const result = validateProvidedCapability(`${CONSUMER_IDENTITY_PROVIDER_CAPABILITY}@1.0.0`);
    expect(result.ok).toBe(true);
    if (result.ok) expect(providedCapabilityName(result.parsed)).toBe(CONSUMER_IDENTITY_PROVIDER_CAPABILITY);
  });

  it('`identity` is not a kernel namespace; `consumer` is — why the socket is not consumer:*', () => {
    expect(KERNEL_CAPABILITY_NAMESPACES.has('identity')).toBe(false);
    expect(KERNEL_CAPABILITY_NAMESPACES.has('consumer')).toBe(true);
    expect(validateProvidedCapability('consumer:provider@1.0.0')).toEqual({ ok: false, reason: 'kernel_namespace' });
  });

  it('the package index re-exports it', () => {
    expect(runtimeApiIndex.CONSUMER_IDENTITY_PROVIDER_CAPABILITY).toBe(CONSUMER_IDENTITY_PROVIDER_CAPABILITY);
  });
});

// §9.171 H3/M1 — the health-record exchange socket: core's ABDM gate asks it instead of naming
// the add-on package. It must stay DECLARABLE (not a kernel namespace) and exactly `ns:name`.
describe('HEALTH_RECORD_EXCHANGE_CAPABILITY — §9.171 health-record exchange socket', () => {
  it('is health-records:exchange, and `<socket>@1.0.0` validates as a provided capability', () => {
    expect(HEALTH_RECORD_EXCHANGE_CAPABILITY).toBe('health-records:exchange');
    const result = validateProvidedCapability(`${HEALTH_RECORD_EXCHANGE_CAPABILITY}@1.0.0`);
    expect(result).toEqual({
      ok: true,
      parsed: { namespace: 'health-records', name: 'exchange', version: '1.0.0' }
    });
    if (result.ok) expect(providedCapabilityName(result.parsed)).toBe(HEALTH_RECORD_EXCHANGE_CAPABILITY);
  });

  it('its namespace is not a kernel namespace (a package can declare it)', () => {
    expect(KERNEL_CAPABILITY_NAMESPACES.has('health-records')).toBe(false);
  });

  it('the package index re-exports it', () => {
    expect(runtimeApiIndex.HEALTH_RECORD_EXCHANGE_CAPABILITY).toBe(HEALTH_RECORD_EXCHANGE_CAPABILITY);
  });
});
