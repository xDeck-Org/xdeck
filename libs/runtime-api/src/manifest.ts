/**
 * §9.50 — manifest-side capability shape.
 *
 * Slice 2 (manifest schema) will add `capabilities.required` +
 * `.optional` to `package.schema.json` + the AJV validator. This file
 * gives that slice (and Slice 12 — the test harness) a shared TS shape
 * to validate against, so manifest authors get type-checking when they
 * write `package.ts` / use the test harness.
 */

import type { Capability } from './capability';
import {
  isGrantableCapability,
  parseCapability,
  RESERVED_CAPABILITY_FAMILIES,
  RESERVED_STATIC_CAPABILITIES
} from './capability';
import {
  validateProvidedCapability,
  validateProvidedCapabilityEntry,
  providedCapabilityId,
  providedCapabilityName,
  KERNEL_CAPABILITY_NAMESPACES,
  type ProvidedCapabilityEntry
} from './provided-capability';
import { validateConsumedCapability } from './consumed-capability';
import { validateAiSkillEntry, type AiSkillManifestEntry } from './ai-skill';
import {
  AiSkillError,
  ConsumedCapabilityError,
  ProvidedCapabilityError,
  ReservedCapabilityError,
  UnknownCapabilityError
} from './errors';

/**
 * The `capabilities` block in a package manifest. `required` must be granted in full at
 * install time; `optional` are individually toggle-able by the tenant; `provides` (§9.94
 * B5.a, ADR-0019 D9) are the versioned, namespaced capabilities this package OFFERS to
 * OTHER packages through the kernel broker — `<namespace>:<name>@<semver>`, never a kernel
 * namespace (D9.3 kernel-wins). `required`/`optional` are CONSUMED kernel capabilities;
 * `provides` is the new provider half.
 */
export interface ManifestCapabilities {
  required: Capability[];
  optional?: Capability[];
  /**
   * §9.94 B5.a `provides` entries — each is EITHER the bare grammar string
   * `<namespace>:<name>@<semver>` OR (§9.52.15 A2) a {@link ProvidedCapabilityDescriptor}
   * object carrying optional AI-facing metadata (description / mutates / aiExecution /
   * touchesSettings). The bare string resolves to the SAFE defaults (aiExecution `forbidden`).
   */
  provides?: ProvidedCapabilityEntry[];
  /**
   * §9.94 B5.b (ADR-0019 D9.2) — the package→package capabilities this package CONSUMES from
   * OTHER installed packages, as `<namespace>:<name>@<range>`. `required` are HARD (install
   * fails if no installed package provides a satisfying version); `optional` are SOFT (degrade
   * gracefully). Distinct from the top-level `required`/`optional` (which are KERNEL grants the
   * tenant approves) — these are package dependencies resolved by the kernel registry/broker.
   */
  consumes?: ManifestConsumedCapabilities;
  /**
   * §9.94 B5.c — binds each provided capability `<namespace>:<name>` to the sandboxed handler
   * the kernel broker invokes (`{ class, method }`). Every key must correspond to a `provides`
   * entry (an orphan handler is rejected at publish).
   */
  providesHandlers?: Record<string, ProvidedCapabilityHandler>;
  /**
   * §9.52.18 — AI Skills this package DECLARES: plain-English guidance the AI assistant
   * follows for a capability the package provides. Each entry is
   * `{ scope: '<namespace>:<name>', instructions }` (+ optional `id`). GUIDANCE, never
   * authority — a skill can never widen a grant, an `aiExecution` ceiling, or data scope.
   * The PUBLISH sandbox (validated below via {@link validateAiSkillEntry}): a package skill
   * MUST be capability-scoped to a capability this package itself provides; deck-wide
   * (behavioral) skills are platform/tenant-authored only.
   */
  skills?: AiSkillManifestEntry[];
}

export interface ManifestConsumedCapabilities {
  /** Hard deps — install fails (`CAPABILITY_NOT_PROVIDED`) if unprovided. */
  required?: string[];
  /** Soft deps — degrade gracefully if absent. */
  optional?: string[];
}

/** §9.94 B5.c — the sandboxed class + method backing a provided capability (the broker invokes it). */
export interface ProvidedCapabilityHandler {
  class: string;
  method: string;
}

/**
 * Result of validating a manifest's capabilities. `valid: false` carries
 * the typed errors so the caller (Slice 2 AJV step, Slice 7 CI gate,
 * Slice 12 test harness) can render them.
 */
export interface ManifestValidationResult {
  valid: boolean;
  errors: Array<
    UnknownCapabilityError | ReservedCapabilityError | ProvidedCapabilityError | ConsumedCapabilityError | AiSkillError
  >;
}

/**
 * Validate a manifest's `capabilities` block against the §9.50 catalogue.
 *
 * - Every entry must be parseable (`UnknownCapabilityError` otherwise).
 * - Reserved entries (`class:invoke:*`, `event:emit`, `event:listen`)
 *   are rejected per §9.50.9.1 (`ReservedCapabilityError`).
 * - Empty `required` is valid (pure-utility packages declare no capabilities).
 *
 * Slice 2 wires this into AJV validation; Slice 7 wires it into
 * `validate-on-tag.yml`. The error array lists every violation in one
 * pass so manifest authors fix them all together rather than chasing
 * one-at-a-time CI runs.
 */
/** Options for {@link validateManifestCapabilities}. */
export interface ValidateManifestOptions {
  /**
   * §9.94 B5.b — whether the package is a `system` package. Only `system` packages may declare
   * a BARE kernel-capability MOUNT in `provides` (e.g. `standard/telemetry` → `telemetry:track`);
   * a regular package declaring a bare kernel namespace is rejected (D9.3 kernel-wins). When
   * unknown (omitted), treated as non-system — the safe direction.
   */
  system?: boolean;
  /**
   * §9.52.18 — the qualified package name (`<namespace>/<name>`), used only to derive a stable
   * id for a declared AI Skill (`<packageName>#<scope>`) when it validates. Omitted ⇒ the derived
   * id falls back to `#<scope>` (the reject/accept verdict is unaffected — id is for the resolver).
   */
  packageName?: string;
}

export function validateManifestCapabilities(
  capabilities: ManifestCapabilities,
  options?: ValidateManifestOptions
): ManifestValidationResult {
  const errors: ManifestValidationResult['errors'] = [];
  const allDeclared = [...(capabilities.required ?? []), ...(capabilities.optional ?? [])];
  for (const cap of allDeclared) {
    const parsed = parseCapability(cap);
    if (!parsed) {
      errors.push(new UnknownCapabilityError(cap));
      continue;
    }
    // Reserved-string check covers both static (event:emit / event:listen)
    // and family-level (class:invoke:<anything>) cases.
    if ((RESERVED_STATIC_CAPABILITIES as readonly string[]).includes(parsed.family)) {
      // The reserved list: §9.50.9.1.
      errors.push(new ReservedCapabilityError(cap, `static capability '${parsed.family}' is on the reserved list`));
      continue;
    }
    if (parsed.resourceId !== null && (RESERVED_CAPABILITY_FAMILIES as readonly string[]).includes(parsed.family)) {
      errors.push(new ReservedCapabilityError(cap, `family '${parsed.family}' is on the reserved list`));
      continue;
    }
    // Catch-all — covers typos / wrong-shape capabilities.
    if (!isGrantableCapability(cap)) {
      errors.push(new UnknownCapabilityError(cap));
    }
  }
  // §9.94 B5.a (ADR-0019 D9) — the PROVIDER half. The `provides` list carries TWO forms,
  // discriminated by the `@<semver>` suffix (a robust marker — a kernel-capability string
  // never contains '@', a D9 provided-capability always does):
  //   • a D9 PACKAGE capability `<namespace>:<name>@<semver>` (e.g. `restroin:menu-lookup@1.0.0`)
  //     — strictly validated here: grammar + the D9.3 kernel-wins rule (no shadowing a kernel
  //     namespace). This is the new provider/consumer-graph contract.
  //   • the LEGACY kernel-capability MOUNT form `<kernel-ns>:<verb>` (e.g. `telemetry:track`,
  //     declared by `system` packages like standard/telemetry that BACK a kernel verb). These
  //     intentionally use a kernel namespace and predate this grammar, so the D9 kernel-wins
  //     rule does not apply to them — it would (wrongly) reject the very packages that mount
  //     kernel capabilities. They are NOT unvalidated: B5.b (below, and `options.system`)
  //     restricts the bare form to `system` packages. A non-system package declaring
  //     `email:send` is rejected `system_only`.
  for (const entry of capabilities.provides ?? []) {
    // §9.52.15 A2 — an entry is the bare grammar string OR a descriptor object; the grammar id
    // is the discriminator source either way.
    const cap = providedCapabilityId(entry);
    if (typeof cap !== 'string') {
      errors.push(new ProvidedCapabilityError(String(cap), 'malformed'));
      continue;
    }
    if (cap.includes('@')) {
      // D9 versioned PACKAGE capability — grammar + kernel-wins + (A2) descriptor metadata.
      const result = validateProvidedCapabilityEntry(entry);
      if (!result.ok) errors.push(new ProvidedCapabilityError(cap, result.reason));
      continue;
    }
    // Bare form = legacy kernel-capability MOUNT. Only a `system` package may back a kernel
    // verb; a non-system package declaring a bare kernel namespace (e.g. `email:send`) is
    // claiming to shadow a kernel capability — rejected (D9.3). A bare NON-kernel string is a
    // malformed D9 capability (it must carry `@<semver>`). This closes the asymmetry the
    // adversarial review (wf_ecfe118c) flagged: previously bare entries skipped validation.
    const colon = cap.indexOf(':');
    const ns = colon === -1 ? cap : cap.slice(0, colon);
    if (KERNEL_CAPABILITY_NAMESPACES.has(ns)) {
      if (!options?.system) errors.push(new ProvidedCapabilityError(cap, 'system_only'));
    } else {
      errors.push(new ProvidedCapabilityError(cap, 'malformed'));
    }
  }
  // §9.94 B5.b (ADR-0019 D9.2) — the CONSUMER half. Every `consumes.required`/`.optional`
  // entry must be a valid `<namespace>:<name>@<range>` that does NOT name a kernel namespace.
  // Both hard + soft are validated identically (the hard/soft distinction is an INSTALL-time
  // gate, not a publish-shape concern).
  const consumed = [...(capabilities.consumes?.required ?? []), ...(capabilities.consumes?.optional ?? [])];
  for (const cap of consumed) {
    const result = validateConsumedCapability(cap);
    if (!result.ok) errors.push(new ConsumedCapabilityError(cap, result.reason));
  }
  // The version-stripped `<namespace>:<name>` set this package PROVIDES (D9 versioned form
  // only). Computed once and shared by the §9.94 B5.c handler-orphan check AND the §9.52.18
  // AI-Skill sandbox below — both ask the same question ("does this package provide X?").
  const providedNames = new Set<string>();
  for (const entry of capabilities.provides ?? []) {
    const cap = providedCapabilityId(entry);
    if (typeof cap !== 'string' || !cap.includes('@')) continue; // only D9 versioned provides
    const parsed = validateProvidedCapability(cap);
    if (parsed.ok) providedNames.add(providedCapabilityName(parsed.parsed));
  }

  // §9.94 B5.c — every `providesHandlers` key MUST match a declared D9 provided capability
  // (`<namespace>:<name>`, version stripped). An ORPHAN handler — bound to a capability the
  // package does not provide — is rejected at publish (the security-relevant direction the
  // adversarial review flagged; the registry's provides-gate already makes it unreachable at
  // runtime, but a publish-time reject keeps the contract honest). A D9 provides WITHOUT a
  // handler is allowed here — it is simply not brokerable yet and fails closed (BROKER_NO_HANDLER).
  for (const key of Object.keys(capabilities.providesHandlers ?? {})) {
    if (!providedNames.has(key)) errors.push(new ProvidedCapabilityError(key, 'orphan_handler'));
  }

  // §9.52.18 — AI Skills this package DECLARES. The PUBLISH gate is the prompt-injection
  // SANDBOX: a package skill must be capability-scoped to a capability THIS package provides
  // (deck-wide behavioral guidance is platform/tenant-authored only). `validateAiSkillEntry`
  // returns a typed rejection; the resolver (`resolveAiSkills`) re-drops violators at read-time
  // (defence in depth). A bad skill is thus rejected at tag-time, never silently shipped.
  for (const entry of capabilities.skills ?? []) {
    const res = validateAiSkillEntry(entry, options?.packageName ?? '', [...providedNames]);
    if (!res.ok) {
      const scope =
        entry && typeof entry === 'object' && typeof (entry as AiSkillManifestEntry).scope === 'string'
          ? (entry as AiSkillManifestEntry).scope
          : String((entry as { scope?: unknown } | null)?.scope ?? entry);
      errors.push(new AiSkillError(scope, res.reason));
    }
  }
  return { valid: errors.length === 0, errors };
}
