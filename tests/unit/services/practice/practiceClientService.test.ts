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
  listPracticeClients,
  getPracticeClient,
  createPracticeClient,
  updatePracticeClient,
  deletePracticeClient,
  listClientGroups,
  createClientGroup,
  listClientContacts,
  createClientContact,
  deleteClientContact,
} from '@/modules/accounting/services/practice/practiceClientService';

const COMPANY = 'aaaaaaaa-0000-0000-0000-000000000001';
const CLIENT_ID = 'bbbbbbbb-0000-0000-0000-000000000002';
const GROUP_ID = 'cccccccc-0000-0000-0000-000000000003';
const CONTACT_ID = 'dddddddd-0000-0000-0000-000000000004';

const clientRow = {
  id: CLIENT_ID,
  company_id: COMPANY,
  legal_name: 'Marneweck Holdings (Pty) Ltd',
  trading_name: 'Marneweck',
  registration_no: '2020/123456/07',
  tax_no: '1234567890',
  client_group_id: null,
  assigned_partner_id: null,
  assigned_manager_id: null,
  billing_model: 'hourly',
  status: 'active',
  link_customer_id: null,
  created_at: new Date('2026-01-01'),
  updated_at: new Date('2026-01-01'),
};

beforeEach(() => vi.clearAllMocks());

describe('listPracticeClients', () => {
  it('returns mapped clients for company', async () => {
    sqlMock.mockResolvedValueOnce([{ cnt: 1 }]).mockResolvedValueOnce([clientRow]);
    const result = await listPracticeClients(COMPANY);
    expect(result.total).toBe(1);
    expect(result.clients[0]!.legalName).toBe('Marneweck Holdings (Pty) Ltd');
    expect(result.clients[0]!.companyId).toBe(COMPANY);
  });

  it('filters by status', async () => {
    sqlMock.mockResolvedValueOnce([{ cnt: 0 }]).mockResolvedValueOnce([]);
    const result = await listPracticeClients(COMPANY, { status: 'inactive' });
    expect(result.total).toBe(0);
    expect(result.clients).toHaveLength(0);
  });
});

describe('getPracticeClient', () => {
  it('returns null when not found', async () => {
    sqlMock.mockResolvedValueOnce([]);
    const result = await getPracticeClient(COMPANY, CLIENT_ID);
    expect(result).toBeNull();
  });

  it('returns mapped client when found', async () => {
    sqlMock.mockResolvedValueOnce([clientRow]);
    const result = await getPracticeClient(COMPANY, CLIENT_ID);
    expect(result?.id).toBe(CLIENT_ID);
    expect(result?.billingModel).toBe('hourly');
  });
});

describe('createPracticeClient', () => {
  it('creates and returns the new client', async () => {
    sqlMock.mockResolvedValueOnce([]).mockResolvedValueOnce([clientRow]);
    const result = await createPracticeClient(COMPANY, {
      legalName: 'Marneweck Holdings (Pty) Ltd',
      billingModel: 'hourly',
      status: 'active',
    });
    expect(result.id).toBe(CLIENT_ID);
  });

  it('throws on duplicate legal_name + company', async () => {
    sqlMock.mockResolvedValueOnce([{ id: 'existing' }]);
    await expect(
      createPracticeClient(COMPANY, {
        legalName: 'Marneweck Holdings (Pty) Ltd',
        billingModel: 'hourly',
        status: 'active',
      })
    ).rejects.toThrow('duplicate');
  });
});

describe('updatePracticeClient', () => {
  it('updates and returns modified client', async () => {
    const updated = { ...clientRow, trading_name: 'MH Group', updated_at: new Date() };
    sqlMock.mockResolvedValueOnce([clientRow]).mockResolvedValueOnce([updated]);
    const result = await updatePracticeClient(COMPANY, CLIENT_ID, { tradingName: 'MH Group' });
    expect(result.tradingName).toBe('MH Group');
  });

  it('throws when client not found', async () => {
    sqlMock.mockResolvedValueOnce([]);
    await expect(updatePracticeClient(COMPANY, CLIENT_ID, {})).rejects.toThrow('not found');
  });
});

describe('deletePracticeClient', () => {
  it('soft-deletes by setting status to archived', async () => {
    sqlMock.mockResolvedValueOnce([clientRow]).mockResolvedValueOnce([]);
    await expect(deletePracticeClient(COMPANY, CLIENT_ID)).resolves.toBeUndefined();
  });

  it('throws when client not found', async () => {
    sqlMock.mockResolvedValueOnce([]);
    await expect(deletePracticeClient(COMPANY, CLIENT_ID)).rejects.toThrow('not found');
  });
});

describe('listClientGroups', () => {
  it('returns groups for company', async () => {
    sqlMock.mockResolvedValueOnce([{ id: GROUP_ID, company_id: COMPANY, name: 'Marneweck Group', description: null, created_at: new Date(), updated_at: new Date() }]);
    const groups = await listClientGroups(COMPANY);
    expect(groups[0]!.name).toBe('Marneweck Group');
  });
});

describe('createClientGroup', () => {
  it('inserts and returns the group', async () => {
    sqlMock.mockResolvedValueOnce([{ id: GROUP_ID, company_id: COMPANY, name: 'New Group', description: 'desc', created_at: new Date(), updated_at: new Date() }]);
    const result = await createClientGroup(COMPANY, { name: 'New Group', description: 'desc' });
    expect(result.id).toBe(GROUP_ID);
    expect(result.name).toBe('New Group');
  });
});

describe('listClientContacts', () => {
  it('returns contacts for a client', async () => {
    sqlMock.mockResolvedValueOnce([{ id: CONTACT_ID, company_id: COMPANY, client_id: CLIENT_ID, name: 'John', email: 'j@example.com', phone: null, role: 'Director', is_primary: true, created_at: new Date() }]);
    const contacts = await listClientContacts(COMPANY, CLIENT_ID);
    expect(contacts[0]!.name).toBe('John');
    expect(contacts[0]!.isPrimary).toBe(true);
  });
});

describe('createClientContact', () => {
  it('inserts and returns contact', async () => {
    sqlMock.mockResolvedValueOnce([{ id: CONTACT_ID, company_id: COMPANY, client_id: CLIENT_ID, name: 'Jane', email: 'jane@example.com', phone: null, role: null, is_primary: false, created_at: new Date() }]);
    const result = await createClientContact(COMPANY, CLIENT_ID, { name: 'Jane', email: 'jane@example.com' });
    expect(result.id).toBe(CONTACT_ID);
  });
});

describe('deleteClientContact', () => {
  it('deletes without error', async () => {
    sqlMock.mockResolvedValueOnce([]);
    await expect(deleteClientContact(COMPANY, CONTACT_ID)).resolves.toBeUndefined();
  });
});
