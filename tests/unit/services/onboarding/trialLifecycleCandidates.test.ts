/**
 * The candidate query carries each exclusion (a text check of the SQL as built; the integration suite
 * tests/integration/trial-lifecycle-emails.test.ts runs it against real rows), the exclude-list env is
 * parsed safely, rows map to dates and only known stages, and owners are owners only.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => {
  const calls: { text: string; values: unknown[] }[] = [];
  let rows: unknown[] = [];
  const sql = vi.fn((strings: TemplateStringsArray, ...vals: unknown[]) => {
    let text = strings[0]!;
    const values: unknown[] = [];
    vals.forEach((v, i) => {
      const frag = v as { __text?: string };
      if (frag && typeof frag === 'object' && typeof frag.__text === 'string') text += frag.__text;
      else { values.push(v); text += `$${values.length}`; }
      text += strings[i + 1]!;
    });
    calls.push({ text, values });
    return Object.assign(Promise.resolve(rows), { __text: text });
  });
  return { sql, calls, setRows: (r: unknown[]) => { rows = r; } };
});
vi.mock('@/lib/neon', () => ({ sql: m.sql }));

import { excludedCompanyIds, loadOwners, loadTrialCandidates } from '@/modules/onboarding/services/trialLifecycle/candidates';

const NOW = new Date('2026-11-24T06:30:00Z');
const ID = '11111111-2222-3333-4444-555555555555';
const lastText = () => m.calls[m.calls.length - 1]!.text.replace(/\s+/g, ' ');
afterEach(() => { m.calls.length = 0; m.setRows([]); delete process.env.TRIAL_EMAIL_EXCLUDE_COMPANY_IDS; });

describe('loadTrialCandidates', () => {
  it.each([
    ['has a trial end', 'c.trial_ends_at IS NOT NULL'],
    ['ended no longer ago than the window', 'c.trial_ends_at >= $1::TIMESTAMPTZ - make_interval(days => $2)'],
    ['not deleted', "COALESCE(c.status, 'active') = 'deleted'"],
    ['not demo', 'COALESCE(c.is_demo, false)'],
    ['not the Demo tenant', "c.id = '00000000-0000-0000-0000-000000000001'::uuid"],
    ['not suspended', "c.status IS DISTINCT FROM 'suspended' AND c.suspended_at IS NULL"],
    ['not converted', "s.status IN ('active', 'past_due') AND p.code <> 'trial'"],
    ['not env-excluded', 'NOT (c.id = ANY ($5::UUID[]))'],
    ['done stages ignore released markers', "t.outcome <> 'released'"],
  ])('%s', async (_why, fragment) => {
    await loadTrialCandidates(NOW);
    expect(lastText()).toContain(fragment);
  });

  it('the internal-company predicate is negated', async () => {
    await loadTrialCandidates(NOW);
    expect(lastText()).toMatch(/AND NOT \( COALESCE\(c\.status, 'active'\) = 'deleted'/);
  });

  it('passes the env exclude list as UUIDs', async () => {
    process.env.TRIAL_EMAIL_EXCLUDE_COMPANY_IDS = ` ${ID.toUpperCase()} , not-a-uuid,`;
    await loadTrialCandidates(NOW);
    expect(m.calls[m.calls.length - 1]!.values[4]).toEqual([ID]);
  });

  it('maps rows: string or Date timestamps, unknown stages dropped', async () => {
    m.setRows([{ id: ID, name: 'Example', created_at: '2026-11-01T00:00:00Z', trial_ends_at: new Date('2026-12-01T00:00:00Z'),
      done_stages: ['setup_nudge', 'bogus'] }]);
    const [c] = await loadTrialCandidates(NOW);
    expect(c!.createdAt.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(c!.trialEndsAt.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(c!.doneStages).toEqual(['setup_nudge']);
  });
});

describe('excludedCompanyIds', () => {
  it('keeps only UUIDs, lower-cased', () => {
    expect(excludedCompanyIds(`${ID}, x, ;drop`)).toEqual([ID]);
    expect(excludedCompanyIds(undefined)).toEqual([]);
  });
});

describe('loadOwners', () => {
  it('owners only, active, with an email, scoped to the company', async () => {
    await loadOwners(ID);
    const text = lastText();
    expect(text).toContain("cu.role = 'owner'");
    expect(text).toContain('cu.company_id = $1::UUID');
    expect(text).toContain('u.is_active IS TRUE');
    expect(m.calls[0]!.values).toEqual([ID]);
  });
});
