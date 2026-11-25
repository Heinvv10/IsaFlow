/**
 * The shared fixtures of the quote-conversion suites (quoteConvertService*.test.ts): the mocked `sql` / getQuote handles,
 * the request-transaction context the claim needs, an accepted quote and the SQL text reader. Each suite vi.mocks the
 * modules itself (vi.mock is hoisted per file); this module reads the mocks those install.
 */
import { vi, type MockedFunction } from 'vitest';
import { sql } from '@/lib/neon';
import { als } from '@/lib/als';
import { getQuote } from '@/modules/accounting/services/ar/quoteService';

export const mockSql = sql as unknown as MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
export const mockGetQuote = getQuote as unknown as MockedFunction<typeof getQuote>;

export const COMPANY_ID = '11111111-1111-1111-1111-111111111111';
export const QUOTE_ID = '22222222-2222-2222-2222-222222222222';
export const GL_ACCOUNT_ID = '33333333-3333-3333-3333-333333333333';

/**
 * `claimUnderLockTimeout` refuses to claim outside a request transaction — the
 * claim would autocommit and could not be rolled back with the writes that
 * follow it. These unit tests mock `sql`, so the client only has to exist;
 * `SET LOCAL` goes to the stub.
 */
const requestCtx = {
  client: { query: vi.fn() }, userId: 'u1', companyId: COMPANY_ID, claims: {},
} as unknown as Parameters<typeof als.run>[0];
export const inRequestTx = <T>(fn: () => Promise<T>): Promise<T> => als.run(requestCtx, fn);

export function acceptedQuote() {
  return {
    id: QUOTE_ID,
    quoteNumber: 'QUO-00001',
    clientId: null,
    customerName: 'Acme Corp',
    quoteDate: '2026-07-01',
    expiryDate: null,
    status: 'accepted',
    subtotal: 200,
    taxAmount: 30,
    total: 230,
    notes: null,
    terms: null,
    convertedInvoiceId: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    lines: [
      {
        id: '44444444-4444-4444-4444-444444444444',
        quoteId: QUOTE_ID,
        lineNumber: 1,
        description: 'Consulting services',
        quantity: 2,
        unitPrice: 100,
        taxRate: 15,
        lineTotal: 200,
        accountId: GL_ACCOUNT_ID,
      },
    ],
  };
}

export function sqlTextOf(call: unknown[]): string {
  return (call[0] as readonly string[]).join(' ');
}
