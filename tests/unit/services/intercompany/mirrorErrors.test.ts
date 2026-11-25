/** Intercompany P2: what the receiver's own services throw while building a draft becomes a refusal a person reads, or stays a defect. */
import { describe, expect, it } from 'vitest';
import { ConnectionRefusal } from '@/modules/accounting/services/intercompany/connectionTypes';
import { mapDraftError } from '@/modules/accounting/services/intercompany/mirrorErrors';

describe('mapDraftError', () => {
  it('a duplicate (the unique supplier + number index) is a 409', () => {
    const mapped = mapDraftError(Object.assign(new Error('duplicate key'), { code: '23505' }));
    expect(mapped).toBeInstanceOf(ConnectionRefusal);
    expect(mapped).toMatchObject({ status: 409 });
  });
  it('a refusal passes through unchanged', () => {
    const r = new ConnectionRefusal(400, 'x');
    expect(mapDraftError(r)).toBe(r);
  });
  it('the services\' plain validation Errors become a 400 with their sentence', () => {
    expect(mapDraftError(new Error('Line 1: quantity must be positive'))).toMatchObject({ status: 400, message: 'Line 1: quantity must be positive' });
  });
  it('an account refusal (BILL_LINE_ACCOUNT_REFUSED) is a 400', () => {
    const refusal = Object.assign(new Error('One or more accounts cannot be used'), { code: 'BILL_LINE_ACCOUNT_REFUSED', name: 'BillLineAccountRefusal' });
    expect(mapDraftError(refusal)).toMatchObject({ status: 400 });
  });
  it('another database error, a TypeError and a non-error stay defects (a 5xx, rolled back)', () => {
    const db = Object.assign(new Error('connection lost'), { code: '57P01' });
    expect(mapDraftError(db)).toBe(db);
    const type = new TypeError('x is undefined');
    expect(mapDraftError(type)).toBe(type);
    expect(mapDraftError('boom')).toBe('boom');
  });
});
