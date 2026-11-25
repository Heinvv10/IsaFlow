/**
 * Wave 7 EA1 (review #1932 M2): the portal's "Your details" read. When the migration_admin bank read fails (URL unset,
 * pool or query error) the address still comes back, the bank is null and marked unavailable (not "none on record"),
 * and the warning carries ids only: no address, no bank value, no error message (a pg message can quote values).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ sql: vi.fn(), tx: vi.fn(), warn: vi.fn() }));
vi.mock('@/lib/neon', () => ({ sql: m.sql }));
vi.mock('@/lib/auth/migrationAdminPool', () => ({ migrationAdminTx: m.tx }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: m.warn, error: vi.fn(), debug: vi.fn() } }));

import { readPortalDetails } from '@/modules/accounting/services/payroll/employeePortalDetails';

const ROW = {
  first_name: 'Thandi', last_name: 'One', employee_number: 'E-1', employer: 'Acme',
  residential_street_number: '12', residential_street: 'Kingfisher Avenue', residential_city: 'Pretoria',
  residential_postal_code: '0028', residential_country_code: 'ZA', postal_same_as_residential: true,
};
beforeEach(() => { m.sql.mockReset(); m.tx.mockReset(); m.warn.mockReset(); m.sql.mockResolvedValue([ROW]); });

describe('readPortalDetails', () => {
  it('reads the bank line by the session company and employee only, as name + last four', async () => {
    const client = { query: vi.fn(async () => ({ rows: [{ bank_name: 'FNB', last4: '3456' }] })) };
    m.tx.mockImplementation(async (_l: string, fn: (c: unknown) => unknown) => fn(client));
    const d = await readPortalDetails('co-A', 'emp-1');
    expect(d).toMatchObject({ employeeName: 'Thandi One', bank: { bankName: 'FNB', accountLast4: '3456' }, bankUnavailable: false });
    expect(d?.address?.residential.street).toBe('Kingfisher Avenue');
    expect(client.query).toHaveBeenCalledWith(expect.stringMatching(/right\(account_number, 4\)[\s\S]*company_id = \$1::uuid AND employee_id = \$2::uuid AND is_active/), ['co-A', 'emp-1']);
  });

  it.each([
    ['the URL is unset', new Error('MIGRATION_ADMIN_DATABASE_URL required: credential, membership and portal writes (S-07b/c/d)')],
    ['the query fails quoting a value', Object.assign(new Error('value "62000123456" violates something'), { name: 'DatabaseError' })],
  ])('when %s: the address still shows, the bank is unavailable, the log holds ids only', async (_what, err) => {
    m.tx.mockRejectedValue(err);
    const d = await readPortalDetails('co-A', 'emp-1');
    expect(d).toMatchObject({ bank: null, bankUnavailable: true, employer: 'Acme' });
    expect(d?.address?.residential.street).toBe('Kingfisher Avenue');
    expect(m.warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(m.warn.mock.calls[0]);
    expect(logged).toContain('emp-1');
    for (const leak of ['Kingfisher', '0028', '62000123456', 'required']) expect(logged).not.toContain(leak);
  });

  it('no employee row: null, and no bank read at all', async () => {
    m.sql.mockResolvedValue([]);
    expect(await readPortalDetails('co-A', 'emp-x')).toBeNull();
    expect(m.tx).not.toHaveBeenCalled();
  });
});
