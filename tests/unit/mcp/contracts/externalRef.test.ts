import { describe, expect, it } from 'vitest';
import { parseExternalRef } from '@/lib/mcp/contracts/externalRef';

describe('parseExternalRef', () => {
  it('accepts and trims the three fields', () => {
    const r = parseExternalRef({
      external_ref: ' 8f2c ',
      external_document_number: 'INV0000133',
      external_system: 'sage',
    });
    expect(r).toEqual({
      ok: true,
      value: { external_ref: '8f2c', external_document_number: 'INV0000133', external_system: 'sage' },
    });
  });

  it('returns an empty object when nothing was supplied', () => {
    expect(parseExternalRef({})).toEqual({ ok: true, value: {} });
  });

  it('drops a whitespace-only value rather than storing an empty string', () => {
    const r = parseExternalRef({ external_ref: '   ' });
    expect(r).toEqual({ ok: true, value: {} });
  });

  it('names the offending argument on a non-string', () => {
    const r = parseExternalRef({ external_ref: 42 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/external_ref/);
  });

  it('refuses an over-long value instead of letting the column truncate it', () => {
    const r = parseExternalRef({ external_document_number: 'x'.repeat(65) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/external_document_number/);
  });

  it('ignores unrelated arguments', () => {
    const r = parseExternalRef({ customer_id: 'abc', external_system: 'xero' });
    expect(r).toEqual({ ok: true, value: { external_system: 'xero' } });
  });
});
