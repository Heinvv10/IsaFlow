/**
 * D11 round 2 (brk-d11 F1, F2): ONE predicate for "a peer held the row". `isHeldRowError` is what `respondIfLockTimeout`
 * answers 503 and what a service that catches around a savepoint must RE-THROW instead of treating as a refusal.
 * It covers a typed lock timeout, `CAPTURE_EVENT_LOCKED`, a `held` refusal, and a raw SQLSTATE 55P03 / 40P01. A
 * `retryable` refusal that is not held, and ordinary errors, are not in it.
 */
import { describe, expect, it, vi } from 'vitest';
import type { NextApiResponse } from 'next';
import { isHeldRowError } from '@/lib/lockTimeout';
import { respondIfLockTimeout } from '@/lib/apiDocumentLock';
import { PaymentLockTimeoutError } from '@/modules/accounting/services/core/paymentLock';
import { CaptureEventLockedError } from '@/modules/accounting/services/capture/captureEventLock';
import { ReceiptRefusal } from '@/modules/accounting/services/ar/receiptRefusal';
import { SupplierPaymentRefusal } from '@/modules/accounting/services/ap/supplierPaymentRefusal';

const pg = (code: string, message = 'driver text') => Object.assign(new Error(message), { code });

describe('isHeldRowError', () => {
  it.each([
    ['a typed lock timeout', new PaymentLockTimeoutError('p')],
    ['CaptureEventLockedError', new CaptureEventLockedError('e')],
    ['a held ReceiptRefusal', new ReceiptRefusal('x', { retryable: true, held: true })],
    ['a held SupplierPaymentRefusal', new SupplierPaymentRefusal('x', { retryable: true, held: true })],
    ['a raw 55P03', pg('55P03')],
    ['a raw 40P01 (deadlock victim)', pg('40P01')],
  ])('%s -> true', (_n, err) => expect(isHeldRowError(err)).toBe(true));

  it.each([
    ['a retryable refusal that is not held (a state conflict)', new ReceiptRefusal('x', { retryable: true })],
    ['a plain refusal', new SupplierPaymentRefusal('x')],
    ['an ordinary Error', new Error('boom')],
    ['a unique violation', pg('23505')],
    ['a poisoned transaction', pg('25P02')],
    ['a string', 'deadlock'],
    ['undefined', undefined],
  ])('%s -> false', (_n, err) => expect(isHeldRowError(err)).toBe(false));
});

describe('respondIfLockTimeout', () => {
  const run = (err: unknown) => {
    const res = { statusCode: 0, headers: {} as Record<string, string>, body: undefined as unknown,
      setHeader: vi.fn((k: string, v: string) => { res.headers[k] = v; }),
      status: vi.fn((c: number) => { res.statusCode = c; return res; }),
      json: vi.fn((b: unknown) => { res.body = b; return res; }) };
    return { handled: respondIfLockTimeout(res as unknown as NextApiResponse, err), res };
  };
  it('answers a raw deadlock victim 503 + Retry-After with a neutral message (no driver text)', () => {
    const { handled, res } = run(pg('40P01', 'deadlock detected: Process 1 waits for ShareLock on relation "x"'));
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(503);
    expect(res.headers['Retry-After']).toBe('2');
    expect(JSON.stringify(res.body)).not.toMatch(/deadlock|ShareLock|relation/);
    expect(JSON.stringify(res.body)).toMatch(/retry in a moment/);
  });
  it('answers a raw lock_timeout 503', () => expect(run(pg('55P03')).res.statusCode).toBe(503));
  it('leaves a state conflict and an ordinary error to the route', () => {
    expect(run(new ReceiptRefusal('x', { retryable: true })).handled).toBe(false);
    expect(run(new Error('boom')).handled).toBe(false);
  });
});
