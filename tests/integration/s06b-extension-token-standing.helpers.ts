// tests/integration/s06b-extension-token-standing.helpers.ts
//
// Request/response doubles for s06b-extension-token-standing.int.test.ts: an
// extension-ingest POST carrying one transaction, and a response that records
// status and body.

import { vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

export type Res = NextApiResponse & { statusCode: number; body: unknown };

export function mockRes(): Res {
  const res = { statusCode: 200, body: undefined, headersSent: false } as unknown as Res;
  res.status = vi.fn((code: number) => { res.statusCode = code; return res; }) as unknown as Res['status'];
  res.json = vi.fn((body: unknown) => { res.body = body; return res; }) as unknown as Res['json'];
  res.setHeader = vi.fn(() => res) as unknown as Res['setHeader'];
  res.end = vi.fn(() => res) as unknown as Res['end'];
  return res;
}

/** One-transaction batch; `description` makes its content-hash identity unique. */
export function ingestReq(token: string, connectionId: string, description: string): NextApiRequest {
  return {
    method: 'POST',
    url: `/api/accounting/bank-feeds/${connectionId}/extension-ingest`,
    query: { id: connectionId },
    headers: { authorization: `Bearer ${token}` },
    body: {
      scraperId: 'absa', scraperVersion: '1.2.0', bankAccountExternalId: '4051234567',
      fromDate: '2026-09-01', toDate: '2026-09-10',
      transactions: [{ transactionDate: '2026-09-02', amount: -50, description }],
    },
  } as unknown as NextApiRequest;
}
