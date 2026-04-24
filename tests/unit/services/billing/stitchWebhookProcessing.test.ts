/**
 * End-to-end webhook payload processing test.
 *
 * Sends the exact envelope shape we captured from the Stitch Express
 * webhooks "Testing" tab through the signature verifier + processEvent.
 * Acts as a regression guard: if Stitch changes the payload shape we'll
 * see a test failure before production does.
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';
import { createHmac } from 'crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import { Readable } from 'stream';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/api-error-handler', () => ({
  withErrorHandler: (h: unknown) => h,
}));

import { sql } from '@/lib/neon';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import handler from '../../../../pages/api/webhooks/stitch';

const mockSql = sql as unknown as MockedFunction<typeof sql>;

const WEBHOOK_SECRET = 'whsec_' + Buffer.from('thirty-two-byte-test-secret-here').toString('base64');

function signBody(id: string, ts: string, body: string): string {
  const secretBytes = Buffer.from(WEBHOOK_SECRET.slice(6), 'base64');
  const hash = createHmac('sha256', secretBytes).update(`${id}.${ts}.${body}`).digest('base64');
  return `v1,${hash}`;
}

function makeReq(body: string, signed = true): NextApiRequest {
  const svixId = 'msg_test_' + Math.random().toString(36).slice(2);
  const svixTimestamp = Math.floor(Date.now() / 1000).toString();
  const stream = Readable.from([Buffer.from(body, 'utf-8')]) as unknown as NextApiRequest;
  stream.method = 'POST';
  stream.headers = {
    'svix-id': svixId,
    'svix-timestamp': svixTimestamp,
    'svix-signature': signed ? signBody(svixId, svixTimestamp, body) : 'v1,bogus',
  };
  return stream;
}

function makeRes(): NextApiResponse & { _status: number; _body: unknown } {
  const res = {
    _status: 200,
    _body: undefined,
    status(code: number) { this._status = code; return this; },
    json(body: unknown) { this._body = body; return this; },
  };
  return res as unknown as NextApiResponse & { _status: number; _body: unknown };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.STITCH_WEBHOOK_SECRET = WEBHOOK_SECRET;
});

describe('Stitch webhook — real payload processing', () => {
  it('payment.paid (LINK) marks stitch_payment_requests completed and flips invoice to paid', async () => {
    const body = JSON.stringify({
      type: 'payment.paid',
      data: {
        id: '5A26F599-A473-4672-A232-217148000000',
        status: 'PAID',
        type: 'LINK',
        amount: 150000,
        linkId: 'hxvse6FMdVmJbFjUjwTFFE',
      },
    });

    mockSql
      // SELECT existing svix_id — none
      .mockResolvedValueOnce([] as never)
      // INSERT stitch_webhook_events
      .mockResolvedValueOnce([{ id: 'log-1' }] as never)
      // UPDATE stitch_payment_requests — returns the row we correlated on linkId
      .mockResolvedValueOnce([{
        id: 'pr-1',
        purpose: 'customer_invoice',
        company_id: 'co-1',
        customer_invoice_id: 'inv-1',
        amount_cents: '150000',
        status: 'completed',
      }] as never)
      // UPDATE customer_invoices
      .mockResolvedValueOnce([] as never)
      // UPDATE stitch_webhook_events processed=true
      .mockResolvedValueOnce([] as never);

    const req = makeReq(body);
    const res = makeRes();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._body).toEqual({ ok: true });

    // Third call is the stitch_payment_requests UPDATE — it should bind the linkId
    const prUpdateArgs = mockSql.mock.calls[2];
    expect(JSON.stringify(prUpdateArgs)).toContain('hxvse6FMdVmJbFjUjwTFFE');
  });

  it('payment.settled updates existing row to settled', async () => {
    const body = JSON.stringify({
      type: 'payment.settled',
      data: {
        id: '5A26F599-A473-4672-A232-217148000001',
        status: 'SETTLED',
        type: 'LINK',
        amount: 150000,
        linkId: 'hxvse6FMdVmJbFjUjwTFFE',
      },
    });

    mockSql
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([{ id: 'log-2' }] as never)
      .mockResolvedValueOnce([] as never) // UPDATE payment_requests → settled
      .mockResolvedValueOnce([] as never); // UPDATE event log processed

    const res = makeRes();
    await handler(makeReq(body), res);

    expect(res._status).toBe(200);
  });

  it('rejects invalid signature with 401', async () => {
    const body = JSON.stringify({ type: 'payment.paid', data: { id: 'x' } });
    const res = makeRes();
    await handler(makeReq(body, false), res);
    expect(res._status).toBe(401);
  });

  it('duplicate svix-id returns 200 without reprocessing', async () => {
    const body = JSON.stringify({
      type: 'payment.paid',
      data: { id: 'x', linkId: 'link-1', status: 'PAID', type: 'LINK', amount: 100 },
    });

    mockSql.mockResolvedValueOnce([{ id: 'existing', processed: true }] as never);

    const res = makeRes();
    await handler(makeReq(body), res);

    expect(res._status).toBe(200);
    expect(res._body).toEqual({ duplicate: true });
    // Only one query ran — the duplicate check
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it('no-linkId payload still processes (SUBSCRIPTION/CONSENT fallback to data.id)', async () => {
    const body = JSON.stringify({
      type: 'payment.paid',
      data: {
        id: '5A26F599-A473-4672-A232-217148000002',
        status: 'PAID',
        type: 'SUBSCRIPTION',
        amount: 29900,
        subscriptionId: 'sub-xyz',
      },
    });

    mockSql
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([{ id: 'log-3' }] as never)
      .mockResolvedValueOnce([] as never) // no matching payment_request
      .mockResolvedValueOnce([] as never);

    const res = makeRes();
    await handler(makeReq(body), res);

    // Processes without throwing even though we can't match a row (logged as info)
    expect(res._status).toBe(200);
    // Correlates on subscriptionId since no linkId
    expect(JSON.stringify(mockSql.mock.calls[2])).toContain('sub-xyz');
  });

  it('unknown event type is logged and stored but not processed', async () => {
    const body = JSON.stringify({
      type: 'payment.unknown.new',
      data: { id: 'x', linkId: 'link-x', status: 'FOO', type: 'LINK', amount: 100 },
    });

    mockSql
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([{ id: 'log-4' }] as never)
      .mockResolvedValueOnce([] as never); // UPDATE processed=true

    const res = makeRes();
    await handler(makeReq(body), res);

    expect(res._status).toBe(200);
  });
});
