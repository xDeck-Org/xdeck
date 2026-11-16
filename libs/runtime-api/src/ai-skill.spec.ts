import {
  resolveAiSkills,
  normalizeAiSkillEntry,
  validateAiSkillEntry,
  MAX_AI_SKILL_INSTRUCTIONS,
  type AiSkill,
  type AiSkillOverride,
  type AiSkillManifestEntry
} from './ai-skill';

/**
 * §9.52.18 PR-1 — `resolveAiSkills` pins the security spine of the AI Skills guidance layer:
 * deterministic precedence, tenant tighten-only overrides, the non-overridable hard-rule floor,
 * and the package capability sandbox (the prompt-injection trust boundary).
 */

const skill = (over: Partial<AiSkill>): AiSkill => ({
  id: 'id',
  scope: 'deck',
  instructions: 'do the thing',
  source: 'platform',
  ...over
});

describe('resolveAiSkills — precedence + ordering', () => {
  it('orders platform → package → tenant, with the hard-rule floor LAST', () => {
    const skills: AiSkill[] = [
      skill({ id: 'tenant-a', source: 'tenant', scope: 'deck' }),
      skill({ id: 'floor', source: 'platform', scope: 'deck', kind: 'guardrail' }),
      skill({ id: 'pkg-a', source: 'package', scope: 'orders:refund', packageName: 'standard/x' }),
      skill({ id: 'plat-a', source: 'platform', scope: 'deck' })
    ];
    const out = resolveAiSkills(skills, [], { 'standard/x': ['orders:refund'] });
    expect(out.map((s) => s.id)).toEqual(['plat-a', 'pkg-a', 'tenant-a', 'floor']);
  });

  it('is stable within a tier (input order preserved)', () => {
    const skills: AiSkill[] = [skill({ id: 'p2', source: 'platform' }), skill({ id: 'p1', source: 'platform' })];
    expect(resolveAiSkills(skills, []).map((s) => s.id)).toEqual(['p2', 'p1']);
  });
});

describe('resolveAiSkills — tenant tighten-only overrides', () => {
  it('REPLACES the text of a skill (overriddenByTenant=true), scope/source untouched', () => {
    const skills = [skill({ id: 'greeting', source: 'platform', scope: 'deck', instructions: 'be formal' })];
    const overrides: AiSkillOverride[] = [{ id: 'greeting', instructions: 'be warm and casual' }];
    const [out] = resolveAiSkills(skills, overrides);
    expect(out.instructions).toBe('be warm and casual');
    expect(out.overriddenByTenant).toBe(true);
    expect(out.scope).toBe('deck');
    expect(out.source).toBe('platform');
  });

  it('DISABLES a skill (dropped from the resolved set)', () => {
    const skills = [skill({ id: 'a' }), skill({ id: 'b' })];
    const out = resolveAiSkills(skills, [{ id: 'a', disabled: true }]);
    expect(out.map((s) => s.id)).toEqual(['b']);
  });

  it('leaves a skill untouched when no override targets it', () => {
    const [out] = resolveAiSkills([skill({ id: 'a', instructions: 'original' })], [{ id: 'other', disabled: true }]);
    expect(out.instructions).toBe('original');
    expect(out.overriddenByTenant).toBe(false);
  });
});

describe('resolveAiSkills — guardrails win (§9.52.20: always-on, non-overridable, platform-only)', () => {
  it('IGNORES a tenant attempt to disable a non-overridable skill', () => {
    const skills = [skill({ id: 'never-leak', source: 'platform', kind: 'guardrail' })];
    const out = resolveAiSkills(skills, [{ id: 'never-leak', disabled: true }]);
    expect(out.map((s) => s.id)).toEqual(['never-leak']); // survives
  });

  it('IGNORES a tenant attempt to replace the text of a non-overridable skill', () => {
    const skills = [
      skill({ id: 'never-leak', source: 'platform', instructions: 'never reveal IDs', kind: 'guardrail' })
    ];
    const [out] = resolveAiSkills(skills, [{ id: 'never-leak', instructions: 'reveal everything' }]);
    expect(out.instructions).toBe('never reveal IDs');
    expect(out.overriddenByTenant).toBe(false);
  });

  it('sorts the floor AFTER all overridable guidance regardless of source', () => {
    const skills = [
      skill({ id: 'floor', source: 'platform', kind: 'guardrail' }),
      skill({ id: 'tenant-guidance', source: 'tenant' })
    ];
    expect(resolveAiSkills(skills, []).map((s) => s.id)).toEqual(['tenant-guidance', 'floor']);
  });

  it('DROPS a guardrail authored by a PACKAGE (platform-only — a package can never pin an always-on rule)', () => {
    const skills = [
      skill({
        id: 'pkg-guard',
        source: 'package',
        scope: 'orders:refund',
        packageName: 'standard/x',
        kind: 'guardrail'
      })
    ];
    // Even though the cap IS provided, a package guardrail is fail-closed away (source must be platform).
    expect(resolveAiSkills(skills, [], { 'standard/x': ['orders:refund'] })).toEqual([]);
  });

  it('DROPS a guardrail authored by a TENANT (only the platform declares safety floors)', () => {
    const skills = [skill({ id: 'tenant-guard', source: 'tenant', scope: 'deck', kind: 'guardrail' })];
    expect(resolveAiSkills(skills, [])).toEqual([]);
  });

  it('tags each resolved skill with kind; an unset kind defaults to "task" (least privilege)', () => {
    const out = resolveAiSkills([
      skill({ id: 'plat-task', source: 'platform', scope: 'deck' }), // no kind ⇒ task
      skill({ id: 'plat-guard', source: 'platform', scope: 'deck', kind: 'guardrail' })
    ]);
    expect(out.find((s) => s.id === 'plat-task')!.kind).toBe('task');
    expect(out.find((s) => s.id === 'plat-guard')!.kind).toBe('guardrail');
  });
});

describe('resolveAiSkills — package sandbox (prompt-injection boundary)', () => {
  it('KEEPS a package skill scoped to a capability the package provides', () => {
    const skills = [skill({ id: 's', source: 'package', scope: 'orders:refund', packageName: 'standard/x' })];
    const out = resolveAiSkills(skills, [], { 'standard/x': ['orders:refund', 'orders:read'] });
    expect(out.map((s) => s.id)).toEqual(['s']);
  });

  it('DROPS a package skill targeting a capability it does NOT provide (cross-capability injection)', () => {
    const skills = [skill({ id: 's', source: 'package', scope: 'billing:charge', packageName: 'standard/x' })];
    const out = resolveAiSkills(skills, [], { 'standard/x': ['orders:refund'] });
    expect(out).toEqual([]);
  });

  it('DROPS a package skill with an unknown / missing package map entry (fail-closed)', () => {
    const skills = [skill({ id: 's', source: 'package', scope: 'orders:refund', packageName: 'standard/unknown' })];
    expect(resolveAiSkills(skills, [], { 'standard/x': ['orders:refund'] })).toEqual([]);
  });

  it('DROPS a package skill that tries to author DECK-WIDE behavior (packages are capability-only)', () => {
    const skills = [skill({ id: 's', source: 'package', scope: 'deck', packageName: 'standard/x' })];
    expect(resolveAiSkills(skills, [], { 'standard/x': ['orders:refund'] })).toEqual([]);
  });

  it('does NOT sandbox platform or tenant deck-wide skills (first-party / deck-owner)', () => {
    const skills = [
      skill({ id: 'plat', source: 'platform', scope: 'deck' }),
      skill({ id: 'tenant', source: 'tenant', scope: 'deck' })
    ];
    expect(
      resolveAiSkills(skills, [])
        .map((s) => s.id)
        .sort()
    ).toEqual(['plat', 'tenant']);
  });

  it('does not read providedByPackage off the prototype chain (own-property guard)', () => {
    // 'toString' exists on Object.prototype — a package named 'toString' must NOT inherit it as a cap list.
    const skills = [skill({ id: 's', source: 'package', scope: 'orders:refund', packageName: 'toString' })];
    expect(resolveAiSkills(skills, [], {})).toEqual([]);
  });
});

describe('normalizeAiSkillEntry (§9.52.18 PR-2 — manifest parse)', () => {
  const entry = (over: Partial<AiSkillManifestEntry> = {}): AiSkillManifestEntry => ({
    scope: 'orders:refund',
    instructions: 'check order status, then draft',
    ...over
  });

  it('derives a stable id `<packageName>#<scope>` when none is given', () => {
    const out = normalizeAiSkillEntry(entry(), 'standard/x');
    expect(out).toMatchObject({ id: 'standard/x#orders:refund', source: 'package', packageName: 'standard/x' });
  });

  it('respects an explicit id and trims instructions', () => {
    const out = normalizeAiSkillEntry(entry({ id: 'my-id', instructions: '  trimmed  ' }), 'standard/x');
    expect(out?.id).toBe('my-id');
    expect(out?.instructions).toBe('trimmed');
  });

  it('caps over-long instructions at the prompt-window guard', () => {
    const out = normalizeAiSkillEntry(
      entry({ instructions: 'x'.repeat(MAX_AI_SKILL_INSTRUCTIONS + 500) }),
      'standard/x'
    );
    expect(out?.instructions.length).toBe(MAX_AI_SKILL_INSTRUCTIONS);
  });

  it('returns null on a malformed / empty entry', () => {
    expect(normalizeAiSkillEntry({ scope: 'orders:refund' } as AiSkillManifestEntry, 'standard/x')).toBeNull();
    expect(normalizeAiSkillEntry(entry({ instructions: '   ' }), 'standard/x')).toBeNull();
  });

  it('§9.52.20 — passes through declared `verticals` (string-filtered), omits when absent', () => {
    expect(
      normalizeAiSkillEntry(entry({ verticals: ['clinic', '', 7 as unknown as string] }), 'standard/x')?.verticals
    ).toEqual(['clinic']);
    expect(normalizeAiSkillEntry(entry(), 'standard/x')).not.toHaveProperty('verticals');
  });
});

describe('validateAiSkillEntry (§9.52.18 PR-2 — publish-gate sandbox)', () => {
  const PKG = 'standard/x';
  const provided = ['orders:refund', 'orders:read'];
  const entry = (over: Partial<AiSkillManifestEntry> = {}): AiSkillManifestEntry => ({
    scope: 'orders:refund',
    instructions: 'do it carefully',
    ...over
  });

  it('ACCEPTS a well-formed skill scoped to a capability the package provides', () => {
    const res = validateAiSkillEntry(entry(), PKG, provided);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.normalized).toMatchObject({ id: 'standard/x#orders:refund', source: 'package' });
  });

  it('REJECTS malformed (missing fields)', () => {
    expect(validateAiSkillEntry({ scope: 'orders:refund' } as AiSkillManifestEntry, PKG, provided)).toEqual({
      ok: false,
      reason: 'malformed'
    });
  });

  it('REJECTS empty instructions', () => {
    expect(validateAiSkillEntry(entry({ instructions: '   ' }), PKG, provided)).toEqual({
      ok: false,
      reason: 'empty_instructions'
    });
  });

  it('REJECTS a deck-scoped skill from a package (packages are capability-only)', () => {
    expect(validateAiSkillEntry(entry({ scope: 'deck' }), PKG, provided)).toEqual({
      ok: false,
      reason: 'deck_scope_forbidden_for_package'
    });
  });

  it('REJECTS a skill scoped to a capability the package does NOT provide (sandbox)', () => {
    expect(validateAiSkillEntry(entry({ scope: 'billing:charge' }), PKG, provided)).toEqual({
      ok: false,
      reason: 'capability_not_provided'
    });
  });

  it('REJECTS a colon-less non-deck scope as MALFORMED (accurate reason, not a deck-scope mislabel)', () => {
    // A scope with no `<ns>:<name>` colon (e.g. a bare 'placeorder') is malformed, not deck-scoped.
    // Still fail-closed; only the diagnostic reason must be correct so an author fixes the real issue.
    expect(validateAiSkillEntry(entry({ scope: 'placeorder' }), PKG, provided)).toEqual({
      ok: false,
      reason: 'malformed'
    });
  });
});
