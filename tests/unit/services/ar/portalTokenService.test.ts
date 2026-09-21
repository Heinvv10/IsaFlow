/**
 * Unit tests for portalTokenService.ts — PRD-06 Phase 2.
 *
 * Verifies:
 *   1. getOrMintInvoicePortalToken returns the existing token when present.
 *   2. getOrMintInvoicePortalToken mints + persists a 64-hex token when absent.
 *   3. getOrMintInvoicePortalToken throws for cancelled/soft-deleted invoices
 *      (invoice-lifetime TTL enforcement at mint time).
 *   4. verifyInvoicePortalToken rejects malformed tokens without hitting the DB.
 *   5. verifyInvoicePortalToken resolves valid tokens, returning the invoice
 *      + company it unlocks.
 *   6. verifyInvoicePortalToken returns null for unknown/cancelled tokens.
 *   7. hashSessionToken is deterministic SHA-256 and never returns the raw token.
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';
import crypto from 'node:crypto';

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn(), { transaction: vi.fn() });
  return { sql: sqlMock };
});

import { sql } from '@/lib/neon';
import {
  getInvoicePortalToken,
  getOrMintInvoicePortalToken,
  hashSessionToken,
  verifyInvoicePortalToken,
} from '@/modules/accounting/services/ar/portalTokenService';

const mockSql = sql as unknown as MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;

const COMPANY_ID = '11111111-1111-1111-1111-111111111111';
const INVOICE_ID = '22222222-2222-2222-2222-222222222222';
const EXISTING_TOKEN = 'a'.repeat(64);
const PERSISTED_TOKEN = 'b'.repeat(64);

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.isaflow.co.za';
});

describe('getOrMintInvoicePortalToken', () => {
  it('returns the existing portal_token when the invoice already has one', async () => {
    mockSql.mockResolvedValueOnce([{ portal_token: EXISTING_TOKEN }]);

    const { token, url } = await getOrMintInvoicePortalToken(INVOICE_ID, COMPANY_ID);

    expect(token).toBe(EXISTING_TOKEN);
    expect(url).toBe(`https://app.isaflow.co.za/portal/invoice/${EXISTING_TOKEN}`);
    expect(mockSql).toHaveBeenCalledOnce();
  });

  it('mints and persists a 64-hex token when none exists', async () => {
    mockSql
      .mockResolvedValueOnce([{ portal_token: null }])
      .mockResolvedValueOnce([{ portal_token: PERSISTED_TOKEN }]);

    const { token, url } = await getOrMintInvoicePortalToken(INVOICE_ID, COMPANY_ID);

    expect(token).toBe(PERSISTED_TOKEN);
    expect(url).toBe(`https://app.isaflow.co.za/portal/invoice/${token}`);
    expect(mockSql).toHaveBeenCalledTimes(2);

    const updateValues = mockSql.mock.calls[1]!.slice(1);
    expect(updateValues).toContain(INVOICE_ID);
    expect(updateValues).toContain(COMPANY_ID);
    // A freshly minted candidate is offered to COALESCE, but the stored value wins.
    expect(
      updateValues.some(v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v) && v !== PERSISTED_TOKEN),
    ).toBe(true);
  });

  it('returns the token the UPDATE stored, not its own mint, when a concurrent render won', async () => {
    // COALESCE(portal_token, $minted) keeps the first writer's token, so
    // RETURNING hands back the other request's value — emailing our own mint
    // instead would produce a link that is not in the database (a 404).
    const RIVAL_TOKEN = 'c'.repeat(64);
    mockSql
      .mockResolvedValueOnce([{ portal_token: null }])
      .mockResolvedValueOnce([{ portal_token: RIVAL_TOKEN }]);

    const { token, url } = await getOrMintInvoicePortalToken(INVOICE_ID, COMPANY_ID);

    expect(token).toBe(RIVAL_TOKEN);
    expect(url).toBe(`https://app.isaflow.co.za/portal/invoice/${RIVAL_TOKEN}`);
  });

  it('throws when the invoice is cancelled or soft-deleted (invoice-lifetime TTL)', async () => {
    mockSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await expect(
      getOrMintInvoicePortalToken(INVOICE_ID, COMPANY_ID),
    ).rejects.toThrow(/not found or not eligible/i);
    expect(mockSql).toHaveBeenCalledTimes(2);
  });

  it('scopes the lookup by company_id', async () => {
    mockSql.mockResolvedValueOnce([{ portal_token: EXISTING_TOKEN }]);

    await getOrMintInvoicePortalToken(INVOICE_ID, COMPANY_ID);

    const lookupValues = mockSql.mock.calls[0]!.slice(1);
    expect(lookupValues).toContain(COMPANY_ID);
    expect(lookupValues).toContain(INVOICE_ID);
  });
});

describe('getInvoicePortalToken (read-only)', () => {
  it('returns the stored token and issues no UPDATE', async () => {
    mockSql.mockResolvedValueOnce([{ portal_token: EXISTING_TOKEN }]);

    expect(await getInvoicePortalToken(INVOICE_ID, COMPANY_ID)).toBe(EXISTING_TOKEN);
    expect(mockSql).toHaveBeenCalledOnce();
  });

  it('returns null — and still mints nothing — when the invoice has no token', async () => {
    mockSql.mockResolvedValueOnce([{ portal_token: null }]);

    expect(await getInvoicePortalToken(INVOICE_ID, COMPANY_ID)).toBeNull();
    expect(mockSql).toHaveBeenCalledOnce();
  });

  it('returns null for an invoice of another company', async () => {
    mockSql.mockResolvedValueOnce([]);

    expect(await getInvoicePortalToken(INVOICE_ID, COMPANY_ID)).toBeNull();
    const lookupValues = mockSql.mock.calls[0]!.slice(1);
    expect(lookupValues).toContain(COMPANY_ID);
  });
});

describe('verifyInvoicePortalToken', () => {
  it('rejects malformed tokens without querying the DB', async () => {
    const result = await verifyInvoicePortalToken('not-a-hex-token');
    expect(result).toBeNull();
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('rejects empty tokens', async () => {
    expect(await verifyInvoicePortalToken('')).toBeNull();
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('rejects tokens with wrong length', async () => {
    expect(await verifyInvoicePortalToken('abc123')).toBeNull();
    expect(await verifyInvoicePortalToken('a'.repeat(63))).toBeNull();
    expect(await verifyInvoicePortalToken('a'.repeat(65))).toBeNull();
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns invoiceId + companyId for a valid token on an open invoice', async () => {
    mockSql.mockResolvedValueOnce([
      { id: INVOICE_ID, company_id: COMPANY_ID, status: 'sent' },
    ]);

    const verified = await verifyInvoicePortalToken(EXISTING_TOKEN);

    expect(verified).toEqual({
      invoiceId: INVOICE_ID,
      companyId: COMPANY_ID,
      status: 'sent',
    });
  });

  it('returns null when the token is unknown (or invoice cancelled/deleted)', async () => {
    mockSql.mockResolvedValueOnce([]);
    expect(await verifyInvoicePortalToken(EXISTING_TOKEN)).toBeNull();
  });
});

describe('hashSessionToken', () => {
  it('returns a hex SHA-256 that never equals the raw token', () => {
    const hash = hashSessionToken(EXISTING_TOKEN);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toBe(EXISTING_TOKEN);
    expect(hash).toBe(
      crypto.createHash('sha256').update(EXISTING_TOKEN).digest('hex'),
    );
  });

  it('is deterministic across calls', () => {
    expect(hashSessionToken(EXISTING_TOKEN)).toBe(hashSessionToken(EXISTING_TOKEN));
  });

  it('produces different hashes for different tokens', () => {
    expect(hashSessionToken('a'.repeat(64))).not.toBe(hashSessionToken('b'.repeat(64)));
  });
});
