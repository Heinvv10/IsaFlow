/**
 * The mirrored documents' eliminations are derived (never stored): the TS side turns each row the database function returns into group-account
 * lines. An invoice: sender revenue debit, receiver expense credit. A credit note (negative row): the sides swapped, in positive amounts. A row
 * whose revenue or expense side has no group account is left out and logged.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ sql: vi.fn(), log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/neon', () => ({ sql: m.sql }));
vi.mock('@/lib/logger', () => ({ log: m.log }));

import { getMirroredEliminations, MIRRORED_LABEL } from '@/modules/accounting/services/reports/mirrorEliminations';

const G = '80000000-0000-4000-8000-000000000001';
const row = (id: string, amount: number) => ({ transaction_id: id, source_company_id: 'A', target_company_id: 'B', amount, transaction_date: '2026-09-01', description: 'Invoice 1 (mirrored)' });
const ga = (id: string, type: string) => ({ id, account_code: id, account_name: id, account_type: type });

beforeEach(() => { m.sql.mockReset(); vi.clearAllMocks(); });

describe('getMirroredEliminations', () => {
  it('an invoice: revenue debited, expense credited, labelled automatic', async () => {
    m.sql.mockResolvedValueOnce([row('t1', 1000)]).mockResolvedValueOnce([ga('REV', 'revenue')]).mockResolvedValueOnce([ga('EXP', 'expense')]);
    const [e] = await getMirroredEliminations(G, '2026-01-01', '2026-12-31');
    expect(e!.description).toBe(`${MIRRORED_LABEL} - Invoice 1 (mirrored)`);
    expect(e!.lines.map((l) => [l.groupAccountId, l.debit, l.credit])).toEqual([['REV', 1000, 0], ['EXP', 0, 1000]]);
  });

  it('a credit note (a negative row): the sides swapped, in positive amounts', async () => {
    m.sql.mockResolvedValueOnce([row('t2', -200)]).mockResolvedValueOnce([ga('REV', 'revenue')]).mockResolvedValueOnce([ga('EXP', 'expense')]);
    const [e] = await getMirroredEliminations(G, '2026-01-01', '2026-12-31');
    expect(e!.lines.map((l) => [l.groupAccountId, l.debit, l.credit])).toEqual([['REV', 0, 200], ['EXP', 200, 0]]);
    expect(e!.amount).toBe(-200);
  });

  it('a row with no mapped revenue or expense group account is left out and logged', async () => {
    m.sql.mockResolvedValueOnce([row('t3', 50)]).mockResolvedValueOnce([ga('REV', 'revenue')]).mockResolvedValueOnce([]);
    expect(await getMirroredEliminations(G, '2026-01-01', '2026-12-31')).toEqual([]);
    expect(m.log.warn).toHaveBeenCalledWith(expect.stringMatching(/left out/), { groupId: G, transactionId: 't3' }, 'accounting');
  });
});
