import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlMock } = vi.hoisted(() => {
  const sqlMock = vi.fn();
  return { sqlMock };
});

vi.mock('@/lib/neon', () => ({ sql: sqlMock }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import {
  listCompanyUsers,
  getCompanyUser,
} from '@/modules/accounting/services/practice/practiceUsersService';

const COMPANY = 'aaaaaaaa-0000-0000-0000-000000000001';
const USER_ID = 'eeeeeeee-0000-0000-0000-000000000005';

const userRow = {
  id: USER_ID,
  email: 'alice@example.com',
  first_name: 'Alice',
  last_name: 'Smith',
  company_role: 'admin',
};

const userRowNoName = {
  id: 'ffffffff-0000-0000-0000-000000000006',
  email: 'noreply@example.com',
  first_name: null,
  last_name: null,
  company_role: 'member',
};

beforeEach(() => vi.clearAllMocks());

describe('listCompanyUsers', () => {
  it('returns mapped users for a company', async () => {
    sqlMock.mockResolvedValueOnce([userRow]);
    const result = await listCompanyUsers(COMPANY);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe(USER_ID);
    expect(result[0]!.email).toBe('alice@example.com');
    expect(result[0]!.firstName).toBe('Alice');
    expect(result[0]!.lastName).toBe('Smith');
    expect(result[0]!.displayName).toBe('Alice Smith');
    expect(result[0]!.companyRole).toBe('admin');
  });

  it('displayName falls back to email when name absent', async () => {
    sqlMock.mockResolvedValueOnce([userRowNoName]);
    const result = await listCompanyUsers(COMPANY);
    expect(result).toHaveLength(1);
    expect(result[0]!.firstName).toBeNull();
    expect(result[0]!.lastName).toBeNull();
    expect(result[0]!.displayName).toBe('noreply@example.com');
  });
});

describe('getCompanyUser', () => {
  it('returns null when not found', async () => {
    sqlMock.mockResolvedValueOnce([]);
    const result = await getCompanyUser(COMPANY, USER_ID);
    expect(result).toBeNull();
  });

  it('returns mapped user when found', async () => {
    sqlMock.mockResolvedValueOnce([userRow]);
    const result = await getCompanyUser(COMPANY, USER_ID);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(USER_ID);
    expect(result!.displayName).toBe('Alice Smith');
    expect(result!.companyRole).toBe('admin');
  });
});
