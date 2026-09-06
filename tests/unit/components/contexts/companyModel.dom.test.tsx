/**
 * The two translations CompanyProvider used to do inline, now testable on
 * their own. `/api/accounting/companies` answers with raw database rows on one
 * path and mapped objects on another, and the provider has always accepted
 * both casings — a mapper that quietly dropped one side would show as an empty
 * company switcher or a blank VAT number, not as an error.
 *
 * `.tsx` so it runs under the jsdom config: the storage helpers need a window.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  mapCompanyRow, mapCompanyUsers, readStoredCompany, readStoredCompanyId,
  writeStoredCompany, clearStoredCompany, COMPANY_STORAGE_KEY,
} from '@/contexts/companyModel';

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('mapCompanyRow', () => {
  it('reads a snake_case database row', () => {
    const c = mapCompanyRow({
      id: 'c1', name: 'Acme', trading_name: 'Acme Fibre', vat_number: '4123456789',
      address_line1: '1 Main Rd', postal_code: '8001', is_active: false,
      idle_timeout_minutes: 30, is_demo: true, financial_year_start: 3,
    });
    expect(c).toMatchObject({
      id: 'c1', name: 'Acme', tradingName: 'Acme Fibre', vatNumber: '4123456789',
      addressLine1: '1 Main Rd', postalCode: '8001', isActive: false,
      idleTimeoutMinutes: 30, isDemo: true, financialYearStart: 3,
    });
  });

  it('reads a camelCase row just the same', () => {
    const c = mapCompanyRow({ id: 'c1', name: 'Acme', tradingName: 'Acme Fibre', vatNumber: '41', isDemo: true });
    expect(c).toMatchObject({ tradingName: 'Acme Fibre', vatNumber: '41', isDemo: true });
  });

  it('defaults isActive to true and isDemo to false when the row says neither', () => {
    const c = mapCompanyRow({ id: 'c1', name: 'Acme' });
    expect(c.isActive).toBe(true);
    expect(c.isDemo).toBe(false);
  });

  it('keeps an explicit false rather than falling back to the default', () => {
    expect(mapCompanyRow({ id: 'c1', name: 'A', is_active: false }).isActive).toBe(false);
    expect(mapCompanyRow({ id: 'c1', name: 'A', isDemo: false }).isDemo).toBe(false);
  });
});

describe('mapCompanyUsers', () => {
  it('reads both casings and coerces isDefault', () => {
    expect(mapCompanyUsers([
      { company_id: 'c1', company_name: 'One', role: 'owner', is_default: true },
      { companyId: 'c2', companyName: 'Two', role: 'viewer' },
    ])).toEqual([
      { companyId: 'c1', companyName: 'One', role: 'owner', isDefault: true },
      { companyId: 'c2', companyName: 'Two', role: 'viewer', isDefault: false },
    ]);
  });

  it('returns an empty list for anything that is not an array', () => {
    expect(mapCompanyUsers(null)).toEqual([]);
    expect(mapCompanyUsers({ items: [] })).toEqual([]);
    expect(mapCompanyUsers(undefined)).toEqual([]);
  });
});

describe('the stored active company', () => {
  it('round-trips through storage', () => {
    writeStoredCompany({ id: 'c1', name: 'Acme', isDemo: true });
    expect(readStoredCompany()).toEqual({ id: 'c1', name: 'Acme', isDemo: true });
    expect(readStoredCompanyId()).toBe('c1');
    clearStoredCompany();
    expect(readStoredCompany()).toBeNull();
  });

  it('treats a malformed entry as absent rather than throwing', () => {
    window.localStorage.setItem(COMPANY_STORAGE_KEY, '{not json');
    expect(readStoredCompany()).toBeNull();
    const onError = vi.fn();
    expect(readStoredCompanyId(onError)).toBeNull();
    // The provider's existing warning still fires at its call site.
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('needs both an id and a name for the first-paint stub, but only an id for the target', () => {
    window.localStorage.setItem(COMPANY_STORAGE_KEY, JSON.stringify({ id: 'c1' }));
    expect(readStoredCompany()).toBeNull();
    expect(readStoredCompanyId()).toBe('c1');
  });
});
