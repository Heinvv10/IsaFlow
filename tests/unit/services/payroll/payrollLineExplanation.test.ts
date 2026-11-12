/**
 * EX-core review round 1: reading a line's stored explanation. Only a schema-1 record with all four figures (each a
 * numeric result and an array of steps) is "recorded"; anything else ({"schema":1}, another schema, steps not an array)
 * is not recorded. Final = approved or paid, whatever the approval-time columns say. The "recorded from" date is the
 * company's earliest line with an explanation (null: none), and the message says each case truthfully. Tenancy and
 * the route are proved in tests/integration/ex-core-line-explanation.int.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const st = vi.hoisted(() => ({ line: null as null | Record<string, unknown>, first: null as Date | null, queries: [] as string[] }));

vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async (strings: TemplateStringsArray) => {
    const q = strings.join('?');
    st.queries.push(q);
    if (q.includes('MIN(l.created_at)')) return [{ first: st.first }];
    if (q.includes('SELECT l.explanation')) return st.line ? [st.line] : [];
    throw new Error(`unexpected query ${q.slice(0, 60)}`);
  }),
}));

import { getLineExplanation, isExplanations, LineExplanationNotFound } from '@/modules/accounting/services/payroll/payrollLineExplanation';
import { notRecordedMessage } from '@/components/payroll/lineExplanationModel';

const fig = { steps: [], result: 0 };
const full = { schema: 1, taxYear: 2027, calculationVersion: 10, paye: fig, uif: fig, sdl: fig, eti: fig };
const C = '00000000-0000-4000-8000-000000000001';
const R = '22222222-2222-4222-8222-222222222222';
const E = '11111111-1111-4111-8111-111111111111';
const COSTED = new Date('2026-11-01T08:00:00Z');

beforeEach(() => { st.line = null; st.first = null; st.queries = []; });

describe('isExplanations', () => {
  it('takes a schema-1 record with four figures, each with steps and a numeric result', () => {
    expect(isExplanations(full)).toBe(true);
  });

  it.each([
    ['{"schema":1}', { schema: 1 }],
    ['another schema', { ...full, schema: 2 }],
    ['steps not an array', { ...full, eti: { steps: {}, result: 0 } }],
    ['a result that is not a number', { ...full, sdl: { steps: [], result: '0' } }],
    ['null', null],
  ])('refuses %s', (_name, v) => {
    expect(isExplanations(v)).toBe(false);
  });
});

describe('getLineExplanation', () => {
  it('a line not found (another company, cancelled, not on the run) throws LineExplanationNotFound, in one query', async () => {
    await expect(getLineExplanation(C, R, E)).rejects.toBeInstanceOf(LineExplanationNotFound);
    expect(st.queries).toHaveLength(1);
    expect(st.queries[0]).toContain("h.status <> 'cancelled'");
    expect(st.queries[0]).toContain('h.company_id = ?::uuid');
  });

  it('a recorded line is returned in one query; approved and paid are final, a calculated run is not', async () => {
    for (const [status, final] of [['approved', true], ['paid', true], ['calculated', false], ['draft', false]] as const) {
      st.line = { explanation: full, status, costed_at: COSTED };
      st.queries = [];
      expect(await getLineExplanation(C, R, E)).toEqual({ state: 'recorded', final, explanations: full });
      expect(st.queries).toHaveLength(1);
    }
  });

  it('{"schema":1} reads as not recorded, with the costed time and the company\'s first recorded line', async () => {
    st.line = { explanation: { schema: 1 }, status: 'approved', costed_at: COSTED };
    st.first = new Date('2026-11-12T06:00:00Z');
    expect(await getLineExplanation(C, R, E)).toEqual({
      state: 'not_recorded', final: true, costedAt: COSTED.toISOString(), recordedFrom: '2026-11-12T06:00:00.000Z',
    });
    // Both reads are this company's: the line by its header, the first recorded line likewise.
    expect(st.queries).toHaveLength(2);
    for (const q of st.queries) expect(q).toContain('h.company_id = ?::uuid');
    expect(st.queries[1]).toContain('l.explanation IS NOT NULL');
  });

  it('no line of the company has one yet: recordedFrom is null', async () => {
    st.line = { explanation: null, status: 'paid', costed_at: COSTED };
    expect(await getLineExplanation(C, R, E)).toMatchObject({ state: 'not_recorded', final: true, recordedFrom: null });
  });
});

describe('the not-recorded message', () => {
  it('a draft line costed before the first recorded line (or with none recorded yet) is told why, and asked to recalculate', () => {
    const why = 'This line was calculated before explanations were recorded; recalculate the run to see how it was calculated.';
    expect(notRecordedMessage(false, '2026-11-12T06:00:00.000Z', COSTED.toISOString())).toBe(why);
    expect(notRecordedMessage(false, null, COSTED.toISOString())).toBe(why);
  });

  it('a draft line costed after it (code that did not record one) is only asked to recalculate', () => {
    expect(notRecordedMessage(false, '2026-10-01T06:00:00.000Z', COSTED.toISOString())).toBe('Recalculate the run to see how this was calculated.');
  });

  it('a final run costed before the first recorded line: "Not recorded for runs costed before <date>"', () => {
    expect(notRecordedMessage(true, '2026-11-12T06:00:00.000Z', COSTED.toISOString())).toBe('Not recorded for runs costed before 12 Nov 2026.');
  });

  it('a final run costed after it (code that did not record one): says when it was costed, not "before"', () => {
    expect(notRecordedMessage(true, '2026-10-01T06:00:00.000Z', COSTED.toISOString()))
      .toBe('Not recorded: this run was costed on 01 Nov 2026 by a version of IsaFlow that did not keep explanations.');
  });

  it('no recorded line at all: said without a date', () => {
    expect(notRecordedMessage(true, null, COSTED.toISOString())).toBe('Not recorded for runs costed before explanations were kept.');
  });
});
