// tests/unit/services/bank/feed/bankIngestionValidation.test.ts
import { describe, expect, it } from 'vitest';
import { contentHashIdentity, identityModeFor, validateBatch } from '@/modules/accounting/services/bank/feed/bankIngestionValidation';
import type { BankIngestionBatch, NormalizedBankTransaction } from '@/modules/accounting/services/bank/feed/bankIngestionTypes';

const tx = (o: Partial<NormalizedBankTransaction> = {}): NormalizedBankTransaction => ({
  identity: { kind: 'provider', providerTransactionId: 'p1' }, state: 'posted',
  transactionDate: '2026-09-01', amount: -10, currency: 'ZAR', description: 'X', ...o,
});
const batch = (txs: NormalizedBankTransaction[]): BankIngestionBatch => ({
  source: { kind: 'feed', connectionId: 'c1' }, fetchedAt: '2026-09-11T08:00:00Z', transactions: txs,
});
const code = (fn: () => void): string | undefined => {
  try { fn(); return undefined; } catch (e) { return (e as { code?: string }).code; }
};

describe('identityModeFor', () => {
  it('extension is content_hash', () => expect(identityModeFor('extension')).toBe('content_hash'));
  it('manual_csv cannot ingest', () => expect(code(() => identityModeFor('manual_csv'))).toBe('UNSUPPORTED_PROVIDER'));
  it('any other provider is provider identity', () => expect(identityModeFor('test_provider')).toBe('provider'));
});

describe('validateBatch', () => {
  it('accepts a clean provider batch', () => expect(() => validateBatch(batch([tx()]), 'provider')).not.toThrow());
  it('rejects an impossible calendar date', () =>
    expect(code(() => validateBatch(batch([tx({ transactionDate: '2026-02-30' })]), 'provider'))).toBe('INVALID_TRANSACTION'));
  it('rejects a non-finite amount', () =>
    expect(code(() => validateBatch(batch([tx({ amount: Number.NaN })]), 'provider'))).toBe('INVALID_TRANSACTION'));
  it('rejects a non-ZAR currency', () =>
    expect(code(() => validateBatch(batch([tx({ currency: 'USD' as 'ZAR' })]), 'provider'))).toBe('INVALID_TRANSACTION'));
  it('rejects a blank description', () =>
    expect(code(() => validateBatch(batch([tx({ description: '  ' })]), 'provider'))).toBe('INVALID_TRANSACTION'));
  it('rejects a reference longer than the column', () =>
    expect(code(() => validateBatch(batch([tx({ reference: 'r'.repeat(256) })]), 'provider'))).toBe('INVALID_TRANSACTION'));
  it('rejects a repeated provider id in one batch', () =>
    expect(code(() => validateBatch(batch([tx(), tx()]), 'provider'))).toBe('DUPLICATE_PROVIDER_ID'));
  it('rejects content-hash identity on a provider connection', () => {
    const t = tx({ identity: contentHashIdentity({ transactionDate: '2026-09-01', amount: -10, description: 'X' }) });
    expect(code(() => validateBatch(batch([t]), 'provider'))).toBe('IDENTITY_MODE_MISMATCH');
  });
  it('rejects a content hash that does not match the fields', () => {
    const t = tx({ identity: { kind: 'content_hash', contentHash: 'deadbeef' } });
    expect(code(() => validateBatch(batch([t]), 'content_hash'))).toBe('INVALID_TRANSACTION');
  });
  it('rejects a non-posted state on a content-hash batch', () => {
    const fields = { transactionDate: '2026-09-01', amount: -10, description: 'X' };
    const t = tx({ ...fields, state: 'pending', identity: contentHashIdentity(fields) });
    expect(code(() => validateBatch(batch([t]), 'content_hash'))).toBe('IDENTITY_MODE_MISMATCH');
  });
  it('rejects an amount that is not whole cents (A-8)', () =>
    expect(code(() => validateBatch(batch([tx({ amount: -10.005 })]), 'provider'))).toBe('INVALID_TRANSACTION'));
  it('accepts whole-cent amounts that float cannot represent exactly', () => {
    for (const amount of [0.1, -0.29, 1234.56, -99999.99, 0.07, 282543.34, 123456789.07, -987654321.13]) {
      expect(() => validateBatch(batch([tx({ amount })]), 'provider')).not.toThrow();
    }
  });
  it('caps a user-supplied value echoed into the refusal message at 40 chars (A-7)', () => {
    const long = `2026-09-01${'x'.repeat(500)}`;
    for (const t of [tx({ transactionDate: long }), tx({ valueDate: long }), tx({ currency: long as 'ZAR' })]) {
      try { validateBatch(batch([t]), 'provider'); throw new Error('expected a refusal'); } catch (e) {
        expect((e as { code?: string }).code).toBe('INVALID_TRANSACTION');
        expect((e as Error).message).not.toContain('x'.repeat(41));
        expect((e as Error).message.length).toBeLessThan(120);
      }
    }
  });
  it('allows two identical content-hash rows (two real R50 fees)', () => {
    const fields = { transactionDate: '2026-09-01', amount: -50, description: 'FEE' };
    const t = tx({ ...fields, identity: contentHashIdentity(fields) });
    expect(() => validateBatch(batch([t, t]), 'content_hash')).not.toThrow();
  });
});
