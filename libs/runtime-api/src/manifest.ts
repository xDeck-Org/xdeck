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
import { ReservedCapabilityError, UnknownCapabilityError } from './errors';

/**
 * The `capabilities` block in a package manifest. Required must be
 * granted in full at install time; optional are individually toggle-able
 * by the tenant.
 */
export interface ManifestCapabilities {
  required: Capability[];
  optional?: Capability[];
}

/**
 * Result of validating a manifest's capabilities. `valid: false` carries
 * the typed errors so the caller (Slice 2 AJV step, Slice 7 CI gate,
 * Slice 12 test harness) can render them.
 */
export interface ManifestValidationResult {
  valid: boolean;
  errors: Array<UnknownCapabilityError | ReservedCapabilityError>;
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
export function validateManifestCapabilities(capabilities: ManifestCapabilities): ManifestValidationResult {
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
      errors.push(new ReservedCapabilityError(cap, `static capability '${parsed.family}' reserved per §9.50.9.1`));
      continue;
    }
    if (parsed.resourceId !== null && (RESERVED_CAPABILITY_FAMILIES as readonly string[]).includes(parsed.family)) {
      errors.push(new ReservedCapabilityError(cap, `family '${parsed.family}' reserved per §9.50.9.1`));
      continue;
    }
    // Catch-all — covers typos / wrong-shape capabilities.
    if (!isGrantableCapability(cap)) {
      errors.push(new UnknownCapabilityError(cap));
    }
  }
  return { valid: errors.length === 0, errors };
}
