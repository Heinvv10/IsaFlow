/**
 * Unit tests for sentMirrorAdmin — PRD-06 Phase 6.
 *
 * Covers:
 *   1. listSentConnectionSummaries maps rows → SentMirrorSummary shape
 *   2. createSentImapConnection encrypts the password before insert
 *   3. updateSentConnection returns null when no row matches
 *   4. disconnectSentConnection returns true on match, false otherwise
 *   5. deleteSentConnection returns false when no row deleted
 *   6. listSentScanLog passes through the row list
 *   7. every write goes through migrationAdminTx (S-07e part B, migration 946),
 *      bound to the verified company and never to the app pool's `sql`
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn(), { transaction: vi.fn() });
  return {
    sql: sqlMock,
    withTransaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(sqlMock)),
  };
});

const h = vi.hoisted(() => ({
  admin: [] as Array<{ label: string; text: string; values: unknown[] }>,
  adminRows: [] as unknown[][],
}));

vi.mock('@/lib/auth/migrationAdminPool', () => ({
  migrationAdminTx: async (label: string, fn: (c: unknown) => Promise<unknown>) => fn({
    query: async (text: string, values: unknown[]) => {
      h.admin.push({ label, text: text.replace(/\s+/g, ' ').trim(), values });
      return { rows: h.adminRows.shift() ?? [] };
    },
  }),
}));

vi.mock('@/lib/encryption', () => ({
  encrypt: vi.fn((plain: string) => `enc(${plain})`),
  decrypt: vi.fn((cipher: string) => cipher.replace(/^enc\(|\)$/g, '')),
}));

import { sql } from '@/lib/neon';
import { encrypt } from '@/lib/encryption';
import {
  listSentConnectionSummaries,
  createSentImapConnection,
  updateSentConnection,
  disconnectSentConnection,
  deleteSentConnection,
  listSentScanLog,
} from '@/modules/accounting/services/ar/sentMirrorAdmin';

const mockSql = sql as unknown as MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockEncrypt = encrypt as unknown as MockedFunction<typeof encrypt>;

const COMPANY_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CONN_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function rowFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: CONN_ID,
    provider: 'imap',
    display_name: 'Billing Outbound',
    account_email: 'billing@acme.co.za',
    status: 'active',
    sent_folder: 'Sent',
    scan_interval_minutes: 10,
    messages_captured_total: 0,
    messages_linked_total: 0,
    last_scan_at: null,
    last_success_at: null,
    last_error: null,
    created_at: '2026-04-24T00:00:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.admin.length = 0;
  h.adminRows.length = 0;
});

describe('listSentConnectionSummaries', () => {
  it('maps DB rows into the expected summary shape', async () => {
    mockSql.mockResolvedValueOnce([
      rowFixture({ messages_linked_total: 3, messages_captured_total: 1 }),
    ]);
    const result = await listSentConnectionSummaries(COMPANY_ID);
    expect(result).toHaveLength(1);
    expect(result[0]?.sentFolder).toBe('Sent');
    expect(result[0]?.messagesLinkedTotal).toBe(3);
    expect(result[0]?.messagesCapturedTotal).toBe(1);
  });
});

describe('createSentImapConnection', () => {
  it('encrypts the password and inserts the connection', async () => {
    h.adminRows.push([rowFixture()]);
    await createSentImapConnection({
      companyId: COMPANY_ID,
      displayName: 'Billing Outbound',
      accountEmail: 'billing@acme.co.za',
      imapHost: 'imap.gmail.com',
      imapPort: 993,
      imapUsername: 'billing@acme.co.za',
      imapPassword: 'app-password-123',
    });
    expect(mockEncrypt).toHaveBeenCalledWith('app-password-123');
    expect(h.admin).toHaveLength(1);
    expect(h.admin[0]!.text).toContain('INSERT INTO sent_mirror_connections');
    expect(h.admin[0]!.values).toContain('enc(app-password-123)');
    expect(h.admin[0]!.values[0]).toBe(COMPANY_ID);
    expect(mockSql).not.toHaveBeenCalled();
  });
});

describe('updateSentConnection', () => {
  it('returns null when no row matches', async () => {
    h.adminRows.push([]);
    const result = await updateSentConnection({
      id: CONN_ID, companyId: COMPANY_ID, scanIntervalMinutes: 30,
    });
    expect(result).toBeNull();
  });

  it('returns the updated summary when a row matches', async () => {
    h.adminRows.push([rowFixture({ scan_interval_minutes: 30 })]);
    const result = await updateSentConnection({
      id: CONN_ID, companyId: COMPANY_ID, scanIntervalMinutes: 30,
    });
    expect(result?.scanIntervalMinutes).toBe(30);
    expect(h.admin[0]!.text).toMatch(/^UPDATE sent_mirror_connections .*company_id = \$2::uuid/);
    expect(h.admin[0]!.values.slice(0, 2)).toEqual([CONN_ID, COMPANY_ID]);
    expect(mockSql).not.toHaveBeenCalled();
  });
});

describe('disconnectSentConnection', () => {
  it('returns true when a row was updated', async () => {
    h.adminRows.push([{ id: CONN_ID }]);
    expect(await disconnectSentConnection(CONN_ID, COMPANY_ID)).toBe(true);
    expect(h.admin[0]!.text).toContain("SET status = 'disconnected'");
    expect(h.admin[0]!.text).toContain('imap_password_enc = NULL');
    expect(h.admin[0]!.text).toContain('company_id = $2::uuid');
    expect(h.admin[0]!.values).toEqual([CONN_ID, COMPANY_ID]);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns false when no matching row exists', async () => {
    h.adminRows.push([]);
    expect(await disconnectSentConnection(CONN_ID, COMPANY_ID)).toBe(false);
  });
});

describe('deleteSentConnection', () => {
  it('returns false when no row was deleted (cross-tenant guard)', async () => {
    h.adminRows.push([]);
    expect(await deleteSentConnection(CONN_ID, COMPANY_ID)).toBe(false);
    expect(h.admin[0]!.text).toMatch(/^DELETE FROM sent_mirror_connections WHERE id = \$1::uuid AND company_id = \$2::uuid/);
    expect(h.admin[0]!.values).toEqual([CONN_ID, COMPANY_ID]);
    expect(mockSql).not.toHaveBeenCalled();
  });
});

describe('listSentScanLog', () => {
  it('returns rows from the log query', async () => {
    const row = {
      id: 'log-1', imap_uid: '42', recipient: 'customer@x.co.za',
      subject: 'Invoice INV-100', attachment_count: 1,
      outcome: 'linked_to_invoice', error: null,
      linked_invoice_ids: ['inv-1'], captured_document_ids: null,
      scanned_at: '2026-04-24T01:00:00Z',
    };
    mockSql.mockResolvedValueOnce([row]);
    const items = await listSentScanLog(CONN_ID, COMPANY_ID, 25);
    expect(items).toHaveLength(1);
    expect((items[0] as Record<string, unknown>).outcome).toBe('linked_to_invoice');
  });
});
