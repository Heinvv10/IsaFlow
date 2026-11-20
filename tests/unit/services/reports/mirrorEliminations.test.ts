/**
 * The mirrored documents' eliminations are derived (never stored): the database function returns one row per account the two journals used
 * (the sender's revenue lines, the receiver's expense lines, each with its net), and the TS side maps each to ITS group account. An invoice:
 * revenue debited, expense credited. A credit note (negative nets): the sides swapped, in positive amounts. A split bill: one credit per expense
 * account. A row with an account that has no group account is left out whole and logged.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ sql: vi.fn(), log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/neon', () => ({ sql: m.sql }));
vi.mock('@/lib/logger', () => ({ log: m.log }));

import { getMirroredEliminations, MIRRORED_LABEL } from '@/modules/accounting/services/reports/mirrorEliminations';

const G = '80000000-0000-4000-8000-000000000001';
const line = (id: string, amount: number, side: 'revenue' | 'expense', account: string, net: number) => ({
  transaction_id: id, source_company_id: 'A', target_company_id: 'B', amount, key_date: '2026-10-02',
  description: 'Invoice 1 (mirrored)', side, gl_account_id: account, net,
});
const map = (company: string, account: string, ga: string, type: string) => ({
  company_id: company, company_account_id: account, id: ga, account_code: ga, account_name: ga, account_type: type, account_subtype: '',
});
const MAPPINGS = [
  map('A', 'a-rev', 'G-REV', 'revenue'), map('B', 'b-exp', 'G-EXP', 'expense'),
  map('B', 'b-unused', 'G-AAA', 'expense'), map('B', 'b-exp2', 'G-EXP2', 'expense'),
];
const pairs = (e: { lines: { groupAccountId: string; debit: number; credit: number }[] }) => e.lines.map((l) => [l.groupAccountId, l.debit, l.credit]);

beforeEach(() => { m.sql.mockReset(); vi.clearAllMocks(); });

describe('getMirroredEliminations', () => {
  it('an invoice: the journals OWN accounts (not the lowest-coded mapped one), revenue debited, expense credited, labelled automatic', async () => {
    m.sql.mockResolvedValueOnce([line('t1', 1000, 'revenue', 'a-rev', 1000), line('t1', 1000, 'expense', 'b-exp', 1000)]).mockResolvedValueOnce(MAPPINGS);
    const [e] = await getMirroredEliminations(G, '2026-10-01', '2026-10-31');
    expect(e!.description).toBe(`${MIRRORED_LABEL} - Invoice 1 (mirrored)`);
    expect(e!.keyDate).toBe('2026-10-02');
    expect(pairs(e!)).toEqual([['G-REV', 1000, 0], ['G-EXP', 0, 1000]]); // G-AAA (mapped, unused, sorts first) is never chosen
  });

  it('a split bill: one expense credit per account the receiver used', async () => {
    m.sql.mockResolvedValueOnce([
      line('t1', 1000, 'revenue', 'a-rev', 1000), line('t1', 1000, 'expense', 'b-exp', 600), line('t1', 1000, 'expense', 'b-exp2', 400),
    ]).mockResolvedValueOnce(MAPPINGS);
    const [e] = await getMirroredEliminations(G, '2026-10-01', '2026-10-31');
    expect(pairs(e!)).toEqual([['G-REV', 1000, 0], ['G-EXP', 0, 600], ['G-EXP2', 0, 400]]);
  });

  it('a credit note (negative nets): the sides swapped, in positive amounts', async () => {
    m.sql.mockResolvedValueOnce([line('t2', -200, 'revenue', 'a-rev', -200), line('t2', -200, 'expense', 'b-exp', -200)]).mockResolvedValueOnce(MAPPINGS);
    const [e] = await getMirroredEliminations(G, '2026-01-01', '2026-12-31');
    expect(pairs(e!)).toEqual([['G-REV', 0, 200], ['G-EXP', 200, 0]]);
    expect(e!.amount).toBe(-200);
  });

  it('a row with an account that has no group account is left out whole and logged', async () => {
    m.sql.mockResolvedValueOnce([line('t3', 50, 'revenue', 'a-rev', 50), line('t3', 50, 'expense', 'b-unmapped', 50)]).mockResolvedValueOnce(MAPPINGS);
    expect(await getMirroredEliminations(G, '2026-01-01', '2026-12-31')).toEqual([]);
    expect(m.log.warn).toHaveBeenCalledWith(expect.stringMatching(/left out/), { groupId: G, transactionId: 't3' }, 'accounting');
  });

  it('nothing derived: one query, no mapping lookup', async () => {
    m.sql.mockResolvedValueOnce([]);
    expect(await getMirroredEliminations(G, '2026-01-01', '2026-12-31')).toEqual([]);
    expect(m.sql).toHaveBeenCalledTimes(1);
  });
});
