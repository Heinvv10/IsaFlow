/**
 * One company-name lookup for every report surface.
 *
 * Three copies of this query existed — the authenticated pack route, the
 * shared-pack builder and the commentary pack data. A shared link and the
 * owner's own screen printing different names on the same pack is a defect
 * nobody reports and everybody notices.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlMock = vi.fn();
vi.mock('@/lib/neon', () => ({ sql: (...a: unknown[]) => sqlMock(...a) }));

import { getCompanyName } from '@/modules/accounting/services/reports/companyName';

const COMPANY = '11111111-1111-4111-8111-111111111111';

beforeEach(() => { sqlMock.mockReset(); });

describe('getCompanyName', () => {
  it('reads the name for exactly that company id', async () => {
    sqlMock.mockResolvedValue([{ name: 'Brightsphere (Pty) Ltd' }]);
    expect(await getCompanyName(COMPANY)).toBe('Brightsphere (Pty) Ltd');

    const [strings, ...values] = sqlMock.mock.calls[0]!;
    expect((strings as string[]).join('?')).toContain('FROM companies');
    expect(values).toEqual([COMPANY]);
  });

  it('answers "Company" when no row comes back, rather than undefined', async () => {
    sqlMock.mockResolvedValue([]);
    expect(await getCompanyName(COMPANY)).toBe('Company');
  });

  it('answers "Company" when the row carries a NULL name', async () => {
    // `String(null)` is the string "null" — printed as a report header on a
    // document sent to a bank.
    sqlMock.mockResolvedValue([{ name: null }]);
    expect(await getCompanyName(COMPANY)).toBe('Company');
  });

  it('answers "Company" for an empty or whitespace-only name', async () => {
    // companies.name is not constrained against '' , and the pack route used
    // to fall back for it. Without this a blank line prints where the
    // company's name belongs, on a document that gets sent to a bank.
    sqlMock.mockResolvedValue([{ name: '' }]);
    expect(await getCompanyName(COMPANY)).toBe('Company');

    sqlMock.mockResolvedValue([{ name: '   ' }]);
    expect(await getCompanyName(COMPANY)).toBe('Company');
  });

  it('trims a padded name rather than printing the padding', async () => {
    sqlMock.mockResolvedValue([{ name: '  Brightsphere (Pty) Ltd  ' }]);
    expect(await getCompanyName(COMPANY)).toBe('Brightsphere (Pty) Ltd');
  });
});