/**
 * Quality R13 M2 / L9: a mirrored elimination event with an account that has no group account is left out WHOLE and reported (pushed to the
 * caller's `dropped` list and logged at ERROR), never only logged; the derived money is rounded to cents.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const sqlMock = vi.hoisted(() => vi.fn());
const logMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('@/lib/neon', () => ({ sql: sqlMock }));
vi.mock('@/lib/logger', () => ({ log: logMock }));
import { getMirroredEliminations, type DroppedMirroredElimination } from '@/modules/accounting/services/reports/mirrorEliminations';

const ev = (id: string, side: string, acct: string, net: number) => ({ transaction_id: id, source_company_id: 'A', target_company_id: 'B', amount: 1000,
  key_date: '2026-01-15', description: `Invoice ${id}`, side, gl_account_id: acct, net, receiver_journal_id: `j${id}`, kind: 'eliminate' });

beforeEach(() => { sqlMock.mockReset(); for (const f of Object.values(logMock)) f.mockReset(); });

describe('getMirroredEliminations: unmapped accounts', () => {
  it('the event with an unmapped account is left out and reported; the mapped one is applied, rounded to cents', async () => {
    sqlMock
      .mockResolvedValueOnce([ev('t1', 'revenue', 'rev', 333.333333), ev('t1', 'expense', 'exp', 333.333333), ev('t2', 'revenue', 'rev', 1000), ev('t2', 'expense', 'unmapped', 1000)])
      .mockResolvedValueOnce([
        { company_id: 'A', company_account_id: 'rev', id: 'gr', account_code: '4000', account_name: 'Rev', account_type: 'revenue', account_subtype: '' },
        { company_id: 'B', company_account_id: 'exp', id: 'ge', account_code: '5000', account_name: 'Exp', account_type: 'expense', account_subtype: '' },
      ]);
    const dropped: DroppedMirroredElimination[] = [];
    const out = await getMirroredEliminations('g', '2026-01-01', '2026-01-31', dropped);
    expect(out.map((e) => e.transactionId)).toEqual(['t1']);
    expect(out[0]!.lines.map((l) => [l.debit, l.credit])).toEqual([[333.33, 0], [0, 333.33]]);
    expect(dropped).toEqual([{ transactionId: 't2', keyDate: '2026-01-15', description: 'Automatic: mirrored intercompany documents - Invoice t2', amount: 1000 }]);
    expect(logMock.error).toHaveBeenCalledWith(expect.stringMatching(/left out/), expect.objectContaining({ transactionId: 't2' }), 'accounting');
  });
});
