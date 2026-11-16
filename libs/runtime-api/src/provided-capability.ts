/**
 * §9.94 B5.a (ADR-0019 D9) — the PROVIDED-CAPABILITY contract. Packages don't only
 * CONSUME kernel capabilities (the §9.50 grant model); under D9 they also PROVIDE
 * capabilities that OTHER packages consume through the kernel broker. This module is the
 * declaration grammar for that provider half — the pure, sandbox-agnostic primitive the
 * manifest validator (publish time) and the future registry/broker (B5.b/B5.c) build on.
 *
 * ── Grammar (D9): `<namespace>:<name>@<semver>` ─────────────────────────────────────
 *   e.g. `restroin:menu-lookup@1.0.0`. Three parts:
 *     • `namespace` — a flat, shared capability namespace (`[a-z][a-z0-9-]*`). It is NOT
 *       the consuming side's concern (D9.3: the consumer is agnostic to which package
 *       provides). CRITICALLY it must NOT be a KERNEL capability namespace — a package can
 *       ADD capabilities but can NEVER shadow/override `email:*`, `entity:*`, `class:*`,
 *       … (D9.3 "kernel wins"; a package can never hijack `email:send`).
 *     • `name` — the capability verb (`[a-z][a-z0-9-]*`).
 *     • `@<semver>` — a CONCRETE version the provider supplies (D9.5 versioned contracts);
 *       consumers pin a compatible RANGE against it (that resolution lands in B5.b).
 *
 * This is a *declaration* contract only — it confers nothing at runtime. The per-tenant
 * registry (B5.b) records who provides what; the broker (B5.c) mediates the actual call
 * under the consumer-USER's authz (D9.1). Keeping the grammar here (a leaf module with no
 * imports beyond the catalogue) means publish-validation, the registry, and the broker all
 * agree on one parser.
 */

import {
  GRANTABLE_STATIC_CAPABILITIES,
  GRANTABLE_PARAMETERIZED_FAMILIES,
  RESERVED_STATIC_CAPABILITIES,
  RESERVED_CAPABILITY_FAMILIES
} from './capability';

/** A parsed provided capability — the three grammar parts. */
export interface ProvidedCapability {
  namespace: string;
  name: string;
  version: string;
}

/**
 * §9.52.15 A2 — how far the in-app AI assistant (Deckie) may go with a provided capability.
 * The package AUTHOR declares the CEILING in the manifest; a tenant may only TIGHTEN it
 * (never escalate — {@link clampAiExecution}). Enforcement is at the broker/data layer
 * (PR-8), not the prompt — this value is the authoritative gate input, not advice.
 *   • `forbidden` — Deckie may only MENTION the capability, never invoke it.
 *   • `draft`     — Deckie may PREPARE the action for the user's explicit confirmation.
 *   • `auto`      — Deckie may EXECUTE it autonomously (reserve for safe/idempotent verbs).
 */
export type AiExecutionPolicy = 'forbidden' | 'draft' | 'auto';
export const AI_EXECUTION_POLICIES: readonly AiExecutionPolicy[] = ['forbidden', 'draft', 'auto'] as const;
/** Least→most permissive rank, so a tenant override is clampable to ≤ the author ceiling. */
export const AI_EXECUTION_RANK: Record<AiExecutionPolicy, number> = { forbidden: 0, draft: 1, auto: 2 };

export function isAiExecutionPolicy(v: unknown): v is AiExecutionPolicy {
  return v === 'forbidden' || v === 'draft' || v === 'auto';
}

/**
 * §9.52.15 A2 — the OBJECT form of a `capabilities.provides[]` entry: the grammar id plus
 * OPTIONAL AI-facing metadata. The bare-string form stays valid (back-compat) and resolves
 * to the SAFE defaults via {@link normalizeProvidedCapability} (aiExecution `forbidden`,
 * no description, not mutating, not settings-touching).
 */
export interface ProvidedCapabilityDescriptor {
  /** `<namespace>:<name>@<semver>` — the same grammar as the bare-string form. */
  id: string;
  /** Human/AI-readable: what invoking this capability does (shown to Deckie). */
  description?: string;
  /** Does invoking it MUTATE deck data (vs a read/query)? Defaults false. */
  mutates?: boolean;
  /** The AUTHOR's CEILING for Deckie. Defaults `forbidden` — AI execution is strictly opt-in. */
  aiExecution?: AiExecutionPolicy;
  /** Does invoking it change deck/package SETTINGS? Defaults false; gated behind the
   *  deck-level settings-write switch ON TOP of {@link aiExecution}. */
  touchesSettings?: boolean;
}

/** A manifest `capabilities.provides[]` entry: the bare id string, or the rich descriptor. */
export type ProvidedCapabilityEntry = string | ProvidedCapabilityDescriptor;

/** A provided capability with its grammar parts AND resolved (defaulted) AI metadata. */
export interface NormalizedProvidedCapability extends ProvidedCapability {
  description: string | null;
  mutates: boolean;
  /** The author's ceiling (defaulted `forbidden`). The tenant-effective value is computed later. */
  aiExecution: AiExecutionPolicy;
  touchesSettings: boolean;
}

/** The grammar id string from either entry form. */
export function providedCapabilityId(entry: ProvidedCapabilityEntry): string {
  return typeof entry === 'string' ? entry : entry?.id;
}

/**
 * Normalize a `provides[]` entry (string OR descriptor) into grammar parts + defaulted AI
 * metadata, or `null` if the id grammar is invalid. SAFE defaults (AI execution is opt-in):
 * `aiExecution` → `forbidden`, `mutates`/`touchesSettings` → false, `description` → null.
 */
export function normalizeProvidedCapability(entry: ProvidedCapabilityEntry): NormalizedProvidedCapability | null {
  const parsed = parseProvidedCapability(providedCapabilityId(entry));
  if (!parsed) return null;
  const meta: ProvidedCapabilityDescriptor | Record<string, never> = typeof entry === 'string' ? {} : entry;
  return {
    ...parsed,
    description: typeof meta.description === 'string' && meta.description.trim() ? meta.description.trim() : null,
    mutates: meta.mutates === true,
    aiExecution: isAiExecutionPolicy(meta.aiExecution) ? meta.aiExecution : 'forbidden',
    touchesSettings: meta.touchesSettings === true
  };
}

/**
 * Clamp a tenant override to ≤ the author ceiling — the tenant can only TIGHTEN, never
 * escalate (a tenant can't make `auto` what the author marked `draft`/`forbidden`). A
 * missing/invalid override yields the author ceiling unchanged.
 */
export function clampAiExecution(
  authorCeiling: AiExecutionPolicy,
  tenantOverride: AiExecutionPolicy | null | undefined
): AiExecutionPolicy {
  if (!isAiExecutionPolicy(tenantOverride)) return authorCeiling;
  return AI_EXECUTION_RANK[tenantOverride] < AI_EXECUTION_RANK[authorCeiling] ? tenantOverride : authorCeiling;
}

/** Why a provided-capability string is invalid. */
export type ProvidedCapabilityRejection = 'malformed' | 'kernel_namespace';

export type ProvidedCapabilityValidation =
  { ok: true; parsed: ProvidedCapability } | { ok: false; reason: ProvidedCapabilityRejection };

const SEGMENT = /^[a-z][a-z0-9-]*$/;
// Concrete semver (major.minor.patch + optional prerelease/build). A PROVIDES declaration
// is a concrete version the provider ships — NOT a range (ranges are the consumer side).
const CONCRETE_SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/**
 * The KERNEL capability namespaces — the prefix before the first `:` of every kernel
 * capability (grantable + reserved, static + parameterized). DERIVED from the catalogue so
 * it stays in lockstep automatically: a new kernel capability instantly becomes a reserved
 * provider namespace. This is the D9.3 "kernel wins" enforcement set — a package-provided
 * capability whose namespace is in here is rejected at publish time.
 */
export const KERNEL_CAPABILITY_NAMESPACES: ReadonlySet<string> = new Set(
  [
    ...GRANTABLE_STATIC_CAPABILITIES,
    ...GRANTABLE_PARAMETERIZED_FAMILIES,
    ...RESERVED_STATIC_CAPABILITIES,
    ...RESERVED_CAPABILITY_FAMILIES
  ].map((cap) => cap.slice(0, cap.indexOf(':') === -1 ? cap.length : cap.indexOf(':')))
);

/**
 * Parse `<namespace>:<name>@<semver>` into its parts, or `null` if it doesn't match the
 * grammar. Pure shape check — does NOT enforce the kernel-namespace rule (that is a
 * validation concern, kept separate so callers can parse a known-good string cheaply).
 */
export function parseProvidedCapability(input: string): ProvidedCapability | null {
  if (!input || typeof input !== 'string') return null;
  const at = input.indexOf('@');
  if (at === -1 || input.indexOf('@', at + 1) !== -1) return null; // exactly one '@'
  const version = input.slice(at + 1);
  if (!CONCRETE_SEMVER.test(version)) return null;
  const head = input.slice(0, at);
  const colon = head.indexOf(':');
  if (colon === -1 || head.indexOf(':', colon + 1) !== -1) return null; // exactly one ':'
  const namespace = head.slice(0, colon);
  const name = head.slice(colon + 1);
  if (!SEGMENT.test(namespace) || !SEGMENT.test(name)) return null;
  return { namespace, name, version };
}

/**
 * Validate a provided-capability string: grammar + the D9.3 kernel-wins rule. The publish
 * gate (B5.a) and the registry derive-at-install (B5.b) both call this so a package can
 * never DECLARE — let alone provide — a capability that shadows a kernel namespace.
 */
export function validateProvidedCapability(input: string): ProvidedCapabilityValidation {
  const parsed = parseProvidedCapability(input);
  if (!parsed) return { ok: false, reason: 'malformed' };
  if (KERNEL_CAPABILITY_NAMESPACES.has(parsed.namespace)) return { ok: false, reason: 'kernel_namespace' };
  return { ok: true, parsed };
}

/**
 * §9.52.15 A2 (PR3) — a provided capability with its TENANT-EFFECTIVE AI-execution policy
 * resolved: the author ceiling, narrowed by the tenant override (clamp — tenant can only
 * TIGHTEN), and demoted to `forbidden` for a settings-touching capability when the deck has
 * not enabled settings writes. This is what Deckie's context (PR4) shows and what the invoke
 * gate (PR8) enforces. `authorCeiling` is kept for transparency (why a capability is capped).
 */
export interface ResolvedCapabilityPolicy {
  /** `<namespace>:<name>` — the version-stripped capability name. */
  name: string;
  description: string | null;
  mutates: boolean;
  touchesSettings: boolean;
  authorCeiling: AiExecutionPolicy;
  /** The policy Deckie MUST obey: clamp(authorCeiling, tenantOverride), then forbidden if
   *  `touchesSettings && !allowSettingsWrite`. The more-restrictive gate always wins. */
  effectiveExecution: AiExecutionPolicy;
}

/**
 * §9.52.15 A2 (PR3) — resolve the tenant-effective AI-execution policy for a set of provided
 * capabilities. PURE (no I/O): the caller supplies the author descriptors (from manifests),
 * the tenant's per-capability overrides, and the deck-level settings-write switch.
 *
 * Two gates compose, more-restrictive wins: (1) {@link clampAiExecution} narrows the author
 * ceiling to the tenant override (a tenant can only TIGHTEN, never escalate); (2) a
 * `touchesSettings` capability is forced to `forbidden` unless `allowSettingsWrite` is on.
 * Dedup: if two installed packages provide the same `<ns>:<name>`, the MOST RESTRICTIVE
 * author ceiling is kept (fail-safe on conflict). Output is sorted by name (deterministic).
 */
export function resolveCapabilityPolicies(
  descriptors: NormalizedProvidedCapability[],
  tenantOverrides: Record<string, AiExecutionPolicy>,
  allowSettingsWrite: boolean
): ResolvedCapabilityPolicy[] {
  const byName = new Map<string, NormalizedProvidedCapability>();
  for (const d of descriptors) {
    const name = `${d.namespace}:${d.name}`;
    const existing = byName.get(name);
    // keep the MOST RESTRICTIVE author ceiling on a name conflict (lower rank = more restrictive).
    if (!existing || AI_EXECUTION_RANK[d.aiExecution] < AI_EXECUTION_RANK[existing.aiExecution]) {
      byName.set(name, d);
    }
  }
  const out: ResolvedCapabilityPolicy[] = [];
  for (const [name, d] of byName) {
    // own-property guard (defence-in-depth) — never read an override off the prototype chain.
    const override = Object.prototype.hasOwnProperty.call(tenantOverrides, name) ? tenantOverrides[name] : null;
    let effectiveExecution = clampAiExecution(d.aiExecution, override);
    if (d.touchesSettings && !allowSettingsWrite) effectiveExecution = 'forbidden';
    out.push({
      name,
      description: d.description,
      mutates: d.mutates,
      touchesSettings: d.touchesSettings,
      authorCeiling: d.aiExecution,
      effectiveExecution
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Why a provided-capability ENTRY (string or descriptor) is invalid — superset of the
 *  string rejections plus the §9.52.15 A2 metadata rejection. */
export type ProvidedCapabilityEntryRejection = ProvidedCapabilityRejection | 'bad_ai_execution';

/**
 * §9.52.15 A2 — validate a `provides[]` ENTRY in either form: the id grammar + the D9.3
 * kernel-wins rule (via {@link validateProvidedCapability}) AND, for the descriptor form, that
 * `aiExecution` (when present) is a known policy value. The publish gate calls this so a bad
 * AI-execution value is rejected at publish, never silently coerced.
 */
export function validateProvidedCapabilityEntry(
  entry: ProvidedCapabilityEntry
): { ok: true; parsed: ProvidedCapability } | { ok: false; reason: ProvidedCapabilityEntryRejection } {
  const base = validateProvidedCapability(providedCapabilityId(entry));
  if (!base.ok) return base;
  if (typeof entry !== 'string' && entry.aiExecution !== undefined && !isAiExecutionPolicy(entry.aiExecution)) {
    return { ok: false, reason: 'bad_ai_execution' };
  }
  return base;
}

/** Reassemble the canonical string form. Inverse of {@link parseProvidedCapability}. */
export function formatProvidedCapability(cap: ProvidedCapability): string {
  return `${cap.namespace}:${cap.name}@${cap.version}`;
}

// The well-known capability SOCKETS (`BILLING_GATEWAY_CAPABILITY`, `IOT_DEVICE_PLANE_CAPABILITY`)
// live in `./capability`, so the frontend can import them through the `@xdeck/runtime-api/capability`
// subpath; the package index still re-exports both.

/** The namespace-qualified identity WITHOUT the version — the contract key consumers bind a range to. */
export function providedCapabilityName(cap: ProvidedCapability): string {
  return `${cap.namespace}:${cap.name}`;
}
