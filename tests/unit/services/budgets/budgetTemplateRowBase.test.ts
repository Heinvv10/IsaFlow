/**
 * The JSON template row's signed base (MCP budget tools PR 2, review round 1): a row's month values as read, bound
 * by the template signature's HMAC key to the version, financial year, grain and row key (account and member).
 * It decodes only for the same version, year, grain, row and month count, and only unaltered.
 */
import { describe, expect, it, vi } from 'vitest';
import { decodeRowBase, encodeRowBase, type RowBaseMeta } from '@/modules/accounting/services/budgets/budgetTemplateSignature';

vi.stubEnv('JWT_SECRET', 'k'.repeat(40)); // the template signature's key (any value)

const META: RowBaseMeta = { versionId: '10000000-0000-4000-8000-000000000001', fiscalYear: 2027, grain: 'cc1', months: ['2026-03', '2026-04', '2026-05', '2026-06'] };
const ROW = { accountId: '20000000-0000-4000-8000-000000000002', memberId: '30000000-0000-4000-8000-000000000001', cents: [10000, null, -5, 0] };

describe('row base', () => {
  it('round-trips its row exactly', () => {
    const text = encodeRowBase(META, ROW);
    expect(text).toMatch(/^v1:20000000-[^:]+:30000000-[^:]+:10000,,-5,0:[0-9a-f]{64}$/);
    expect(decodeRowBase(META, text)).toEqual(ROW);
    const company = { ...ROW, memberId: null };
    expect(decodeRowBase({ ...META, grain: 'company' }, encodeRowBase({ ...META, grain: 'company' }, company))).toEqual(company);
  });

  it.each([
    ['a value changed', (t: string) => t.replace('10000,', '10001,')],
    ['a blank filled', (t: string) => t.replace(',,', ',0,')],
    ['another account', (t: string) => t.replace('20000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000003')],
    ['another member', (t: string) => t.replace('30000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000009')],
    ['the signature altered', (t: string) => t.slice(0, -1) + (t.endsWith('0') ? '1' : '0')],
    ['not a base', () => 'hello'],
    ['another format version', (t: string) => t.replace(/^v1:/, 'v2:')],
  ])('refused: %s', (_n, alter) => {
    expect(decodeRowBase(META, alter(encodeRowBase(META, ROW)))).toBeNull();
  });

  it('refused for another version, year, grain or month list (round 2: a year of the same length but another shape too)', () => {
    const text = encodeRowBase(META, ROW);
    expect(decodeRowBase({ ...META, versionId: '10000000-0000-4000-8000-000000000002' }, text)).toBeNull();
    expect(decodeRowBase({ ...META, fiscalYear: 2028 }, text)).toBeNull();
    expect(decodeRowBase({ ...META, grain: 'cc2' }, text)).toBeNull();
    expect(decodeRowBase({ ...META, months: [...META.months, '2026-07'] }, text)).toBeNull();
    expect(decodeRowBase({ ...META, months: ['2026-02', '2026-03', '2026-04', '2026-05'] }, text)).toBeNull(); // same count, shifted
  });
});
