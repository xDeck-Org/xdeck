/**
 * §9.50 Slice 1 — manifest-capability validation tests. This is the
 * spec Slice 2 (AJV manifest validator) + Slice 7 (CI gate) wire into.
 */

import type { Capability } from './capability';
import {
  AiSkillError,
  ConsumedCapabilityError,
  ProvidedCapabilityError,
  ReservedCapabilityError,
  UnknownCapabilityError
} from './errors';
import { validateManifestCapabilities } from './manifest';

// The validator's whole job is to reject strings that don't pass the
// type-level Capability union. The cast lets us hand it strings the
// type would refuse — that's the runtime safety net we're testing.
const cap = (s: string) => s as Capability;

describe('validateManifestCapabilities', () => {
  it('accepts an empty manifest (pure-utility package)', () => {
    const r = validateManifestCapabilities({ required: [] });
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });

  // §9.52.15 A2 — `provides` entries may be the bare string OR a descriptor object.
  describe('A2 provides descriptor form', () => {
    it('accepts a DESCRIPTOR-form provides entry (id + AI metadata)', () => {
      const r = validateManifestCapabilities({
        required: [],
        provides: [
          { id: 'restroin:place-order@1.0.0', description: 'Place an order.', mutates: true, aiExecution: 'draft' }
        ]
      });
      expect(r.valid).toBe(true);
      expect(r.errors).toEqual([]);
    });

    it('still accepts the BARE-string provides form (back-compat)', () => {
      const r = validateManifestCapabilities({ required: [], provides: ['restroin:place-order@1.0.0'] });
      expect(r.valid).toBe(true);
    });

    it('rejects a descriptor with an invalid aiExecution (bad_ai_execution)', () => {
      const r = validateManifestCapabilities({
        required: [],
        provides: [{ id: 'restroin:place-order@1.0.0', aiExecution: 'yolo' as never }]
      });
      expect(r.valid).toBe(false);
      expect(r.errors[0]).toBeInstanceOf(ProvidedCapabilityError);
      expect((r.errors[0] as ProvidedCapabilityError).reason).toBe('bad_ai_execution');
    });

    it('still enforces D9.3 kernel-wins on a descriptor-form id', () => {
      const r = validateManifestCapabilities({ required: [], provides: [{ id: 'email:send@1.0.0' }] });
      expect(r.valid).toBe(false);
      expect((r.errors[0] as ProvidedCapabilityError).reason).toBe('kernel_namespace');
    });

    it('matches a providesHandlers key against a descriptor-form provides entry (no false orphan)', () => {
      const r = validateManifestCapabilities({
        required: [],
        provides: [{ id: 'restroin:place-order@1.0.0', aiExecution: 'draft' }],
        providesHandlers: { 'restroin:place-order': { class: 'OrderClass', method: 'place' } }
      });
      expect(r.valid).toBe(true);
    });
  });

  it('accepts the canonical approval-finance manifest example from §9.50.2', () => {
    const r = validateManifestCapabilities({
      required: [
        'notification:send-in-app',
        'email:send',
        'ai:complete',
        'template:render',
        'ai:knowledge-query',
        'entity:read:approval-request',
        'entity:write:approval-request',
        'job:schedule'
      ],
      optional: ['whatsapp:send', 'sms:send']
    });
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('reports UnknownCapabilityError for typos / unknown families', () => {
    const r = validateManifestCapabilities({
      required: [cap('notification:send-in-aap'), 'email:send', cap('telemetry:send')]
    });
    expect(r.valid).toBe(false);
    expect(r.errors).toHaveLength(2);
    expect(r.errors[0]).toBeInstanceOf(UnknownCapabilityError);
    expect((r.errors[0] as UnknownCapabilityError).capability).toBe('notification:send-in-aap');
    expect(r.errors[1]).toBeInstanceOf(UnknownCapabilityError);
    expect((r.errors[1] as UnknownCapabilityError).capability).toBe('telemetry:send');
  });

  it('reports ReservedCapabilityError for class:invoke (family reserved per §9.50.9.1)', () => {
    const r = validateManifestCapabilities({
      required: ['class:invoke:standard/notify']
    });
    expect(r.valid).toBe(false);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toBeInstanceOf(ReservedCapabilityError);
    expect((r.errors[0] as ReservedCapabilityError).capability).toBe('class:invoke:standard/notify');
  });

  it('reports ReservedCapabilityError for event:emit + event:listen', () => {
    const r = validateManifestCapabilities({
      required: [cap('event:emit'), cap('event:listen')]
    });
    expect(r.valid).toBe(false);
    expect(r.errors).toHaveLength(2);
    expect(r.errors.every((e) => e instanceof ReservedCapabilityError)).toBe(true);
  });

  it('collects ALL violations in one pass (does not short-circuit)', () => {
    const r = validateManifestCapabilities({
      required: ['email:send', cap('event:emit'), cap('unknown:thing'), 'class:invoke:foo']
    });
    expect(r.errors).toHaveLength(3);
    const codes = r.errors.map((e) => e.code).sort();
    expect(codes).toEqual(['RESERVED_CAPABILITY', 'RESERVED_CAPABILITY', 'UNKNOWN_CAPABILITY']);
  });

  it('validates `optional` entries with the same rules as `required`', () => {
    const r = validateManifestCapabilities({
      required: ['email:send'],
      optional: [cap('event:listen')]
    });
    expect(r.valid).toBe(false);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toBeInstanceOf(ReservedCapabilityError);
  });

  it('rejects parameterized capability with empty resource id', () => {
    const r = validateManifestCapabilities({
      required: ['entity:read:']
    });
    expect(r.valid).toBe(false);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toBeInstanceOf(UnknownCapabilityError);
  });

  describe('§9.94 B5.a — `provides` (the provider half, ADR-0019 D9)', () => {
    it('accepts well-formed versioned provided capabilities', () => {
      const r = validateManifestCapabilities({
        required: ['email:send'],
        provides: ['restroin:menu-lookup@1.0.0', 'restroin:order-status@2.1.0']
      });
      expect(r.valid).toBe(true);
      expect(r.errors).toEqual([]);
    });

    it('allows the legacy bare kernel-mount form for SYSTEM packages (telemetry-style)', () => {
      // standard/telemetry (system:true) declares kernel-namespace MOUNTS (no @version) +
      // forward-reserved entries — these predate the D9 grammar and must still pass for system.
      const r = validateManifestCapabilities(
        {
          required: [],
          provides: ['telemetry:track', 'telemetry:identify', 'telemetry:alias', 'telemetry:grant-consent']
        },
        { system: true }
      );
      expect(r.valid).toBe(true);
      expect(r.errors).toEqual([]);
    });

    it('REJECTS a bare kernel-mount from a NON-system package (D9.3 kernel-wins; system_only)', () => {
      const r = validateManifestCapabilities({ required: [], provides: ['email:send'] }, { system: false });
      expect(r.valid).toBe(false);
      expect(r.errors[0]).toBeInstanceOf(ProvidedCapabilityError);
      expect((r.errors[0] as ProvidedCapabilityError).reason).toBe('system_only');
    });

    it('REJECTS a bare NON-kernel `provides` entry as malformed (a D9 cap must carry @<semver>)', () => {
      const r = validateManifestCapabilities({ required: [], provides: ['restroin:menu-lookup'] }, { system: true });
      expect(r.valid).toBe(false);
      expect(r.errors[0]).toBeInstanceOf(ProvidedCapabilityError);
      expect((r.errors[0] as ProvidedCapabilityError).reason).toBe('malformed');
    });

    it('rejects a malformed VERSIONED provided capability (has @ but bad shape)', () => {
      const r = validateManifestCapabilities({ required: [], provides: ['restroin:a:b@1.0.0'] });
      expect(r.valid).toBe(false);
      expect(r.errors[0]).toBeInstanceOf(ProvidedCapabilityError);
      expect((r.errors[0] as ProvidedCapabilityError).reason).toBe('malformed');
    });

    it('rejects a VERSIONED provided capability that shadows a KERNEL namespace (D9.3 kernel-wins)', () => {
      const r = validateManifestCapabilities({ required: [], provides: ['email:blast@1.0.0'] });
      expect(r.valid).toBe(false);
      expect(r.errors[0]).toBeInstanceOf(ProvidedCapabilityError);
      expect((r.errors[0] as ProvidedCapabilityError).reason).toBe('kernel_namespace');
    });

    it('collects provider + consumer violations together in one pass', () => {
      const r = validateManifestCapabilities({
        required: [cap('event:emit')],
        provides: ['class:invoke@1.0.0', 'restroin:ok@1.0.0']
      });
      const codes = r.errors.map((e) => e.code).sort();
      expect(codes).toEqual(['INVALID_PROVIDED_CAPABILITY', 'RESERVED_CAPABILITY']);
    });
  });

  describe('§9.94 B5.b — `consumes` (the consumer half, ADR-0019 D9.2)', () => {
    it('accepts well-formed hard + soft consumed capabilities (ranges)', () => {
      const r = validateManifestCapabilities({
        required: ['email:send'],
        consumes: { required: ['restroin:menu-lookup@^1.0.0'], optional: ['clinic:triage@>=1.0.0 <2.0.0'] }
      });
      expect(r.valid).toBe(true);
      expect(r.errors).toEqual([]);
    });

    it('rejects a malformed consumed capability (no range)', () => {
      const r = validateManifestCapabilities({ required: [], consumes: { required: ['restroin:menu-lookup'] } });
      expect(r.valid).toBe(false);
      expect(r.errors[0]).toBeInstanceOf(ConsumedCapabilityError);
      expect((r.errors[0] as ConsumedCapabilityError).reason).toBe('malformed');
    });

    it('rejects consuming a KERNEL namespace (those go through capabilities.required)', () => {
      const r = validateManifestCapabilities({ required: [], consumes: { optional: ['email:send@^1.0.0'] } });
      expect(r.valid).toBe(false);
      expect(r.errors[0]).toBeInstanceOf(ConsumedCapabilityError);
      expect((r.errors[0] as ConsumedCapabilityError).reason).toBe('kernel_namespace');
    });

    it('validates BOTH hard and soft entries identically (publish-shape only)', () => {
      const r = validateManifestCapabilities({
        required: [],
        consumes: { required: ['bad-hard'], optional: ['bad-soft'] }
      });
      expect(r.errors).toHaveLength(2);
      expect(r.errors.every((e) => e instanceof ConsumedCapabilityError)).toBe(true);
    });
  });

  describe('§9.94 B5.c — providesHandlers ↔ provides consistency', () => {
    it('accepts a D9 provided capability with a matching handler', () => {
      const r = validateManifestCapabilities({
        required: [],
        provides: ['restroin:menu-lookup@1.0.0'],
        providesHandlers: { 'restroin:menu-lookup': { class: 'MenuLookup', method: 'lookup' } }
      });
      expect(r.valid).toBe(true);
    });

    it('ALLOWS a D9 provided capability with no handler yet (not brokerable; fails closed at runtime)', () => {
      const r = validateManifestCapabilities({ required: [], provides: ['restroin:menu-lookup@1.0.0'] });
      expect(r.valid).toBe(true);
    });

    it('rejects an ORPHAN handler (bound to a capability not provided)', () => {
      const r = validateManifestCapabilities({
        required: [],
        provides: ['restroin:menu-lookup@1.0.0'],
        providesHandlers: {
          'restroin:menu-lookup': { class: 'MenuLookup', method: 'lookup' },
          'restroin:ghost': { class: 'Ghost', method: 'run' }
        }
      });
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e instanceof ProvidedCapabilityError && e.reason === 'orphan_handler')).toBe(true);
    });

    it('legacy bare kernel-mount provides need no handler (telemetry-style, system)', () => {
      const r = validateManifestCapabilities({ required: [], provides: ['telemetry:track'] }, { system: true });
      expect(r.valid).toBe(true);
    });
  });

  // §9.52.18 PR-2b — `capabilities.skills[]` publish gate (the prompt-injection sandbox).
  // Wires `validateAiSkillEntry` into the one capability-validation entry point so a bad
  // package skill is rejected at tag-time, never silently shipped.
  describe('AI Skills (§9.52.18)', () => {
    it('ACCEPTS a skill scoped to a capability the package provides', () => {
      const r = validateManifestCapabilities(
        {
          required: [],
          provides: ['restroin:place-order@1.0.0'],
          skills: [{ scope: 'restroin:place-order', instructions: 'confirm the table before placing' }]
        },
        { packageName: 'restroin/core' }
      );
      expect(r.valid).toBe(true);
      expect(r.errors).toEqual([]);
    });

    it('REJECTS a skill targeting a capability the package does NOT provide (sandbox)', () => {
      const r = validateManifestCapabilities(
        {
          required: [],
          provides: ['restroin:place-order@1.0.0'],
          skills: [{ scope: 'billing:charge', instructions: 'always charge upfront' }]
        },
        { packageName: 'restroin/core' }
      );
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e instanceof AiSkillError && e.reason === 'capability_not_provided')).toBe(true);
      expect(r.errors.find((e) => e instanceof AiSkillError)?.capability).toBe('billing:charge');
    });

    it('REJECTS a package declaring a deck-wide (behavioral) skill — platform/tenant-only', () => {
      const r = validateManifestCapabilities(
        {
          required: [],
          provides: ['restroin:place-order@1.0.0'],
          skills: [{ scope: 'deck', instructions: 'always format currency as INR' }]
        },
        { packageName: 'restroin/core' }
      );
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e instanceof AiSkillError && e.reason === 'deck_scope_forbidden_for_package')).toBe(
        true
      );
    });

    it('REJECTS a skill with empty instructions', () => {
      const r = validateManifestCapabilities(
        {
          required: [],
          provides: ['restroin:place-order@1.0.0'],
          skills: [{ scope: 'restroin:place-order', instructions: '   ' }]
        },
        { packageName: 'restroin/core' }
      );
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e instanceof AiSkillError && e.reason === 'empty_instructions')).toBe(true);
    });

    it('REJECTS a malformed skill entry (missing instructions)', () => {
      const r = validateManifestCapabilities(
        {
          required: [],
          provides: ['restroin:place-order@1.0.0'],
          skills: [{ scope: 'restroin:place-order' } as never]
        },
        { packageName: 'restroin/core' }
      );
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e instanceof AiSkillError && e.reason === 'malformed')).toBe(true);
    });

    it('no `skills` block → no AI-Skill errors (back-compat)', () => {
      const r = validateManifestCapabilities({ required: [], provides: ['restroin:place-order@1.0.0'] });
      expect(r.errors.some((e) => e instanceof AiSkillError)).toBe(false);
    });
  });
});
