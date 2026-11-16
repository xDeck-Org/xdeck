/**
 * §9.52.18 — **AI Skills**: a plain-English GUIDANCE layer over the §9.52.15 capability model.
 * An AI Skill is a named instruction block the AI assistant (Deckie) follows; it is GUIDANCE,
 * never AUTHORITY — it can NEVER grant a capability, widen an `aiExecution` ceiling, or widen
 * data scope. Authority stays entirely in {@link resolveCapabilityPolicies} (tighten-only) + the
 * data-layer sharing engine (fail-closed). This module is the PURE resolver + types (it mirrors
 * `resolveCapabilityPolicies`); prompt composition, storage, and publish-validation are the
 * backend/AI-module PRs (§9.52.18 PR-2..PR-4).
 *
 * Named `Ai*` (not `Deckie*`) on purpose: the engine is plane-agnostic (§9.52.17), so this
 * primitive is reusable by every AI plane — tenant Deckie, platform Deckie, the future
 * plan-ultra builder-import — not bound to one persona. Product/user-facing name: "Skills".
 *
 * Disambiguation: an **AI Skill** (in-product instruction set) is UNRELATED to this repo's
 * *Claude-Code skills* (`.claude/skills/`, `/xdeck-*`). Same English word, different concept.
 */

/** Where a skill applies: deck-wide (behavioral) or a single capability `<ns>:<name>` (procedural). */
export type AiSkillScope = 'deck' | string;

/** Who declared a skill — drives precedence AND the package sandbox. */
export type AiSkillSource = 'platform' | 'package' | 'tenant';

/**
 * §9.52.20 — the two kinds of skill, formalizing the §9.52.18 `nonOverridable` floor into a typed
 * split (the CLAUDE.md future-readiness rule: a boolean that should have been a status):
 *  • `guardrail` — an always-on, NON-overridable safety/compliance rule (e.g. "never surface another
 *    user's row"; the sensitive-data access-purpose rule for §9.91). PLATFORM-authored ONLY (the
 *    resolver drops a package/tenant guardrail — fail-closed), injected unconditionally, and rendered
 *    LAST so it bounds + wins over all guidance.
 *  • `task` — an advisory playbook (deck-wide or capability-scoped). The default; a tenant may disable
 *    or replace it, and it is the corpus that grows (bounded by the §9.52.20 semantic retrieval pass).
 */
export type AiSkillKind = 'guardrail' | 'task';

export interface AiSkill {
  /** Stable id a tenant override/disable targets (caller-unique within the resolved set). */
  id: string;
  scope: AiSkillScope;
  /** Plain-English guidance — injected into the prompt as DATA, never as authority. */
  instructions: string;
  source: AiSkillSource;
  /** For `source: 'package'` — the providing package, used to enforce the capability sandbox. */
  packageName?: string;
  /**
   * §9.52.20 — `guardrail` = the always-on, non-overridable platform safety floor; `task` (the
   * default when omitted) = advisory guidance. A `guardrail` is fail-closed to `source: 'platform'`
   * by {@link resolveAiSkills}: a package/tenant-authored guardrail is DROPPED, so a non-platform
   * author can never pin an always-on, un-disableable instruction. Guardrails ignore tenant overrides
   * and render LAST (the §9.52.18 hard-rule floor, now typed).
   */
  kind?: AiSkillKind;
  /**
   * §9.52.20 (vertical-grounding) — the tenant verticals this skill applies to (e.g. `['clinic']`).
   * Empty/omitted ⇒ ALL verticals (universal). The composer (which knows the deck's vertical) injects
   * the skill only on a matching deck — so a clinic package's clinical playbooks never reach a
   * restaurant deck, WITHOUT any hardcoded per-vertical branching in `(core)`.
   */
  verticals?: string[];
}

/** A tenant's per-skill override: disable it, or replace its text. Scope/source are immutable. */
export interface AiSkillOverride {
  /** Targets an {@link AiSkill.id}. */
  id: string;
  /** Drop the skill from the resolved set. */
  disabled?: boolean;
  /** Replace the guidance text (the scope is unchanged — retarget/escalate is never allowed). */
  instructions?: string;
}

/** A skill after tenant overrides + the sandbox filter, ordered for prompt composition. */
export interface ResolvedAiSkill {
  id: string;
  scope: AiSkillScope;
  instructions: string;
  source: AiSkillSource;
  /** §9.52.20 — `guardrail` (always-on platform floor, renders last + wins) or `task` (advisory). */
  kind: AiSkillKind;
  /** True when a tenant override replaced the text (transparency). */
  overriddenByTenant: boolean;
}

/** Source precedence for prompt order: platform first, then package, then tenant. */
const SOURCE_RANK: Record<AiSkillSource, number> = { platform: 0, package: 1, tenant: 2 };

/** A capability-scoped skill names a capability `<ns>:<name>` (has a colon); `'deck'` is behavioral. */
function isCapabilityScope(scope: AiSkillScope): boolean {
  return scope !== 'deck' && scope.includes(':');
}

/**
 * §9.52.18 — resolve the tenant-effective AI Skill set. PURE (no I/O): the caller supplies the
 * declared skills (platform + package + tenant-authored), the tenant overrides, and the per-package
 * provided-capability map (for the sandbox).
 *
 * Guarantees (the security spine — each has a unit test):
 *  1. **Sandbox** — a `package` skill MUST be capability-scoped to a capability THAT package
 *     provides. A package skill that is deck-scoped, or names another package's / an unknown
 *     capability, is DROPPED (fail-closed prompt-injection trust boundary). Platform + tenant
 *     skills are not sandboxed (they are first-party / the deck owner's own).
 *  2. **Tighten-only** — a tenant override may DISABLE or REPLACE the text of a skill; it can never
 *     retarget the scope or escalate anything (a skill carries no authority to escalate, by design).
 *  3. **Guardrails win (§9.52.20)** — a `kind: 'guardrail'` skill is the always-on platform floor:
 *     it MUST be `source: 'platform'` (a package/tenant guardrail is DROPPED — the new fail-closed
 *     boundary, so a non-platform author can never pin an un-disableable instruction), it ignores any
 *     tenant override (cannot be disabled or replaced), AND it sorts LAST so it renders after (and
 *     therefore bounds) all advisory `task` guidance.
 *  4. **Deterministic precedence** — platform → package → tenant for `task` skills, with the guardrail
 *     floor appended last; stable within a tier (input order preserved).
 */
export function resolveAiSkills(
  skills: AiSkill[],
  overrides: AiSkillOverride[] = [],
  providedByPackage: Record<string, string[]> = {}
): ResolvedAiSkill[] {
  // Index overrides by id (own-property guard — never read off the prototype chain).
  const overrideById = new Map<string, AiSkillOverride>();
  for (const o of overrides ?? []) {
    if (o && typeof o.id === 'string') overrideById.set(o.id, o);
  }

  const resolved: Array<{ skill: ResolvedAiSkill; order: number }> = [];
  let order = 0;
  for (const s of skills ?? []) {
    if (!s || typeof s.id !== 'string' || typeof s.instructions !== 'string') continue;
    const idx = order++;

    // §9.52.20 — a GUARDRAIL is the always-on, non-overridable platform floor. Fail-closed to
    // `source: 'platform'`: a package- or tenant-authored guardrail is DROPPED, so a non-platform
    // author can never pin an always-on, un-disableable instruction (the new security boundary).
    const isGuardrail = s.kind === 'guardrail';
    if (isGuardrail && s.source !== 'platform') continue;

    // (1) Sandbox: a package skill must name a capability the package itself provides.
    if (s.source === 'package') {
      if (!isCapabilityScope(s.scope)) continue; // packages can't author deck-wide behavior
      const own = Object.prototype.hasOwnProperty.call(providedByPackage, s.packageName ?? '')
        ? providedByPackage[s.packageName ?? '']
        : [];
      if (!Array.isArray(own) || !own.includes(s.scope)) continue; // cross-capability / unknown → dropped
    }

    // (2)+(3) Tenant override — IGNORED for a guardrail (the non-overridable floor; fail-closed).
    const override = isGuardrail ? undefined : overrideById.get(s.id);
    if (override?.disabled) continue;
    const replaced = !!(override && typeof override.instructions === 'string');
    const instructions = replaced ? (override!.instructions as string) : s.instructions;

    resolved.push({
      order: idx,
      skill: {
        id: s.id,
        scope: s.scope,
        instructions,
        source: s.source,
        kind: isGuardrail ? 'guardrail' : 'task',
        overriddenByTenant: replaced
      }
    });
  }

  // (4) Deterministic order: GUARDRAILS last (they bound + win); otherwise by source precedence,
  //     then stable input order within a tier.
  return resolved
    .sort((a, b) => {
      const ag = a.skill.kind === 'guardrail';
      const bg = b.skill.kind === 'guardrail';
      if (ag !== bg) return ag ? 1 : -1;
      const rank = SOURCE_RANK[a.skill.source] - SOURCE_RANK[b.skill.source];
      if (rank !== 0) return rank;
      return a.order - b.order; // stable within a tier
    })
    .map((e) => e.skill);
}

// ─── Manifest declaration + publish-gate validation (§9.52.18 PR-2) ──────────

/**
 * The manifest form a package author writes to DECLARE a skill. A package skill MUST be
 * capability-scoped to a capability the package itself provides (the sandbox); `'deck'` scope
 * is reserved for platform/tenant authors (validated by {@link validateAiSkillEntry}).
 */
export interface AiSkillManifestEntry {
  /** Capability id `<ns>:<name>` (package authors) or `'deck'` (platform/tenant only). */
  scope: AiSkillScope;
  /** Plain-English guidance text. */
  instructions: string;
  /** Optional stable id; defaults to `<packageName>#<scope>` so it is unique + override-targetable. */
  id?: string;
  /** §9.52.20 — verticals this skill applies to (omitted ⇒ all). The composer gates by the deck's vertical. */
  verticals?: string[];
}

/** Why an {@link AiSkillManifestEntry} is rejected at publish. */
export type AiSkillEntryRejection =
  'malformed' | 'empty_instructions' | 'deck_scope_forbidden_for_package' | 'capability_not_provided';

/** Hard cap on a single skill's instruction text (prompt-window guard; validated at publish). */
export const MAX_AI_SKILL_INSTRUCTIONS = 4_000;

/** A skill id that is stable + unique per (package, scope), and override-targetable. */
function deriveAiSkillId(entry: AiSkillManifestEntry, packageName: string): string {
  return typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : `${packageName}#${entry.scope}`;
}

/**
 * §9.52.18 PR-2 — normalize a package manifest skill entry into the internal {@link AiSkill}
 * (source `'package'`). Returns null on a malformed entry. Lenient parse for the loader; the
 * publish gate uses {@link validateAiSkillEntry} for typed rejection reasons.
 */
export function normalizeAiSkillEntry(entry: AiSkillManifestEntry, packageName: string): AiSkill | null {
  if (!entry || typeof entry.scope !== 'string' || typeof entry.instructions !== 'string') return null;
  const instructions = entry.instructions.trim();
  if (!instructions) return null;
  return {
    id: deriveAiSkillId(entry, packageName),
    scope: entry.scope,
    instructions: instructions.slice(0, MAX_AI_SKILL_INSTRUCTIONS),
    source: 'package',
    packageName,
    ...(Array.isArray(entry.verticals)
      ? { verticals: entry.verticals.filter((v): v is string => typeof v === 'string' && v.length > 0) }
      : {})
  };
}

/**
 * §9.52.18 PR-2 — the PUBLISH gate for a package skill: it must be well-formed AND scoped to a
 * capability the package itself provides (the prompt-injection sandbox — a package can never
 * author guidance for another package's capability or for deck-wide behavior). Mirrors
 * {@link validateProvidedCapabilityEntry}. The backend validator calls this at publish so a bad
 * skill is rejected at tag-time, never silently shipped; {@link resolveAiSkills} also drops
 * violators defensively at read-time (defence in depth).
 *
 * `ownProvidedCapabilityNames` is the version-stripped `<ns>:<name>` set the package provides
 * (derive via `providedCapabilityName` from the manifest's `capabilities.provides`).
 */
export function validateAiSkillEntry(
  entry: AiSkillManifestEntry,
  packageName: string,
  ownProvidedCapabilityNames: string[]
): { ok: true; normalized: AiSkill } | { ok: false; reason: AiSkillEntryRejection } {
  if (!entry || typeof entry.scope !== 'string' || typeof entry.instructions !== 'string') {
    return { ok: false, reason: 'malformed' };
  }
  if (!entry.instructions.trim()) return { ok: false, reason: 'empty_instructions' };
  // Distinguish the two non-capability rejections so a package author gets an accurate reason:
  // the literal `'deck'` scope is FORBIDDEN for a package (platform/tenant-only), whereas any other
  // non-capability scope (no `<ns>:<name>` colon) is simply MALFORMED. Both are still rejected
  // (fail-closed); only the diagnostic reason differs.
  if (entry.scope === 'deck') return { ok: false, reason: 'deck_scope_forbidden_for_package' };
  if (!isCapabilityScope(entry.scope)) return { ok: false, reason: 'malformed' };
  if (!ownProvidedCapabilityNames.includes(entry.scope)) return { ok: false, reason: 'capability_not_provided' };
  return { ok: true, normalized: normalizeAiSkillEntry(entry, packageName) as AiSkill };
}
