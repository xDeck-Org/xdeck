/**
 * §9.94 B5.b (ADR-0019 D9.2) — the CONSUMED-CAPABILITY contract: the consumer half of the
 * provider/consumer graph. A package declares which OTHER packages' capabilities it depends
 * on, as `<namespace>:<name>@<range>` — the mirror of the provider's `<namespace>:<name>@<semver>`
 * ({@link parseProvidedCapability}), except the consumer pins a RANGE (`^1.0.0`, `>=1 <2`, `*`)
 * rather than a concrete version.
 *
 * ── Hard vs soft (D9.2) ─────────────────────────────────────────────────────────────
 * The manifest splits consumed capabilities into `required` (HARD — install fails if no
 * installed package provides a satisfying version, the §9.68 peer-dep semantics) and
 * `optional` (SOFT — degrades gracefully if absent). The install gate enforces `required`;
 * the broker (B5.c) resolves each call at runtime.
 *
 * ── Why the lib keeps only the grammar ──────────────────────────────────────────────
 * This module validates the SHAPE (`<ns>:<name>@<range>`) + the D9.3 kernel-wins rule (a
 * package consumes another package's capability, never a kernel one — kernel capabilities
 * are consumed through `capabilities.required`/`.optional` + the grant model, a different
 * mechanism). It deliberately does NOT evaluate the range (range↔version satisfaction is the
 * backend registry's job, reusing the §9.68 semver engine) — so the lib stays dependency-free
 * and the `range` is carried through as an opaque string.
 */

import { KERNEL_CAPABILITY_NAMESPACES } from './provided-capability';

/** A parsed consumed capability — the namespace-qualified verb + the version RANGE depended on. */
export interface ConsumedCapability {
  namespace: string;
  name: string;
  /** Raw semver RANGE string (e.g. `^1.0.0`, `>=1.0.0 <2.0.0`, `*`) — evaluated by the backend registry. */
  range: string;
}

export type ConsumedCapabilityRejection = 'malformed' | 'kernel_namespace';
export type ConsumedCapabilityValidation =
  { ok: true; parsed: ConsumedCapability } | { ok: false; reason: ConsumedCapabilityRejection };

const SEGMENT = /^[a-z][a-z0-9-]*$/;

/**
 * Parse `<namespace>:<name>@<range>` into its parts, or `null` if it doesn't match the
 * grammar. The `range` is captured raw (non-empty) — NOT validated as semver here.
 */
export function parseConsumedCapability(input: string): ConsumedCapability | null {
  if (!input || typeof input !== 'string') return null;
  const at = input.indexOf('@');
  if (at === -1 || input.indexOf('@', at + 1) !== -1) return null; // exactly one '@'
  const range = input.slice(at + 1);
  if (range.length === 0) return null;
  const head = input.slice(0, at);
  const colon = head.indexOf(':');
  if (colon === -1 || head.indexOf(':', colon + 1) !== -1) return null; // exactly one ':'
  const namespace = head.slice(0, colon);
  const name = head.slice(colon + 1);
  if (!SEGMENT.test(namespace) || !SEGMENT.test(name)) return null;
  return { namespace, name, range };
}

/**
 * Validate a consumed-capability string: grammar + the D9.3 kernel-wins rule. A package can
 * never consume a KERNEL-namespaced capability through this contract — those are consumed via
 * `capabilities.required`/`.optional` (the grant model). Symmetric with the provider gate so
 * a malformed/kernel-shadowing dependency is rejected at publish, never silently dropped.
 */
export function validateConsumedCapability(input: string): ConsumedCapabilityValidation {
  const parsed = parseConsumedCapability(input);
  if (!parsed) return { ok: false, reason: 'malformed' };
  if (KERNEL_CAPABILITY_NAMESPACES.has(parsed.namespace)) return { ok: false, reason: 'kernel_namespace' };
  return { ok: true, parsed };
}

/** The namespace-qualified identity WITHOUT the range — the contract key matched against a provider. */
export function consumedCapabilityName(cap: ConsumedCapability): string {
  return `${cap.namespace}:${cap.name}`;
}
