/**
 * systemAccountResolver — deterministic choice between duplicate system rows.
 *
 * The cache used to be last-row-wins over an un-ordered SELECT; production
 * carried two vat_input system rows (one a liability) and heap order decided
 * which one every VAT posting used. The rule now: a row whose type can carry
 * the subtype beats one that cannot, then newest created_at, then id.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import {
  clearSystemAccountCache, getSystemAccount, preferSystemAccount, typeFitsSubtype,
} from '@/modules/accounting/services/gl/systemAccountResolver';

const CO = '4a159669-2f50-46b5-a7b8-2e94dab3d495';
const mockSql = vi.mocked(sql) as unknown as ReturnType<typeof vi.fn>;
const row = (id: string, code: string, type: string, subtype: string, created: string, name = code) =>
  ({ id, account_code: code, account_name: name, account_type: type, account_subtype: subtype, created_at: new Date(created) });

beforeEach(() => { vi.clearAllMocks(); clearSystemAccountCache(); });

describe('duplicate system rows', () => {
  it('a type-consistent row beats a mistyped one regardless of age or order', async () => {
    mockSql.mockResolvedValueOnce([
      row('b', '1140', 'asset', 'vat_input', '2026-04-27'),
      row('a', 'SYS-9', 'liability', 'vat_input', '2026-04-25', 'VAT Payable'),
    ]);
    expect((await getSystemAccount('vat_input', CO)).accountCode).toBe('1140');
    clearSystemAccountCache();
    mockSql.mockResolvedValueOnce([
      row('a', 'SYS-9', 'liability', 'vat_input', '2026-04-28', 'VAT Payable'),
      row('b', '1140', 'asset', 'vat_input', '2026-04-27'),
    ]);
    expect((await getSystemAccount('vat_input', CO)).accountCode).toBe('1140');
  });

  it('between two fitting rows the newer wins, whichever the database returned first', async () => {
    mockSql.mockResolvedValueOnce([
      row('new', '1101', 'asset', 'receivable', '2026-04-24'),
      row('old', '1120', 'asset', 'receivable', '2026-04-13'),
    ]);
    expect((await getSystemAccount('receivable', CO)).id).toBe('new');
    clearSystemAccountCache();
    mockSql.mockResolvedValueOnce([
      row('old', '1120', 'asset', 'receivable', '2026-04-13'),
      row('new', '1101', 'asset', 'receivable', '2026-04-24'),
    ]);
    expect((await getSystemAccount('receivable', CO)).id).toBe('new');
  });

  it('logs an error naming every candidate for a resolved role', async () => {
    mockSql.mockResolvedValueOnce([
      row('a', '2110', 'liability', 'payable', '2026-04-13'),
      row('b', '2001', 'liability', 'payable', '2026-04-24'),
    ]);
    await getSystemAccount('payable', CO);
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining('Duplicate system accounts'),
      expect.objectContaining({ companyId: CO, subtype: 'payable', picked: '2001', candidates: expect.arrayContaining([expect.stringContaining('2110')]) }),
      'accounting',
    );
  });

  it('stays silent for roles the resolver does not hand out (payroll_liability is many by design)', async () => {
    mockSql.mockResolvedValueOnce([
      row('a', '2140', 'liability', 'payroll_liability', '2026-04-13'),
      row('b', '2150', 'liability', 'payroll_liability', '2026-04-13'),
      row('c', '2110', 'liability', 'payable', '2026-04-13'),
    ]);
    await getSystemAccount('payable', CO);
    expect(log.error).not.toHaveBeenCalled();
  });

  it('an unknown created_at ranks oldest, symmetrically — never "whichever came second"', () => {
    const dated = { id: 'a', accountCode: '1', accountName: '', accountType: 'asset', accountSubtype: 'bank', createdAt: 1700000000000 };
    const undated = { ...dated, id: 'b', createdAt: Number.NaN };
    expect(preferSystemAccount(dated, undated).id).toBe('a');
    expect(preferSystemAccount(undated, dated).id).toBe('a');
    const undated2 = { ...undated, id: 'c' };
    expect(preferSystemAccount(undated, undated2).id).toBe('c');
    expect(preferSystemAccount(undated2, undated).id).toBe('c');
  });

  it('a NULL created_at from the database is handled, not compared as a Date string', async () => {
    mockSql.mockResolvedValueOnce([
      { ...row('u', '1101', 'asset', 'receivable', '2026-01-01'), created_at: null },
      row('d', '1120', 'asset', 'receivable', '2026-04-13'),
    ]);
    expect((await getSystemAccount('receivable', CO)).id).toBe('d');
  });

  it('preferSystemAccount is total: equal fit and created_at falls back to id', () => {
    const a = { id: 'a', accountCode: '1', accountName: '', accountType: 'asset', accountSubtype: 'bank', createdAt: 5 };
    const b = { ...a, id: 'b' };
    expect(preferSystemAccount(a, b).id).toBe('b');
    expect(preferSystemAccount(b, a).id).toBe('b');
  });

  it('typeFitsSubtype follows glAccountSubtypes', () => {
    expect(typeFitsSubtype('asset', 'vat_input')).toBe(true);
    expect(typeFitsSubtype('liability', 'vat_input')).toBe(false);
    expect(typeFitsSubtype('equity', 'opening_balance_equity')).toBe(true);
    expect(typeFitsSubtype('revenue', 'disposal_profit_loss')).toBe(true);
    expect(typeFitsSubtype('expense', 'disposal_profit_loss')).toBe(true);
    expect(typeFitsSubtype('nonsense', 'bank')).toBe(false);
  });
});
