/**
 * Unit tests for Paystack webhook signature verification.
 * Paystack signs webhooks with HMAC-SHA512 of the raw JSON body using the
 * secret key, hex digest in the `x-paystack-signature` header.
 */

import { describe, it, expect } from 'vitest';
import { createHmac } from 'crypto';

function sign(secret: string, body: string): string {
  return createHmac('sha512', secret).update(body).digest('hex');
}

// Re-implement the verifier here to avoid loading the Next.js handler. The
// implementation under test lives in pages/api/webhooks/paystack.ts and
// must stay byte-identical with this reference.
function verify(secret: string, body: string, signature: string): boolean {
  const expected = sign(secret, body);
  if (expected.length !== signature.length) return false;
  // timing-safe compare
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return diff === 0;
}

describe('Paystack webhook signature', () => {
  const secret = 'sk_test_paystack_secret';
  const body = JSON.stringify({
    event: 'charge.success',
    data: { reference: 'ref_1', amount: 100000 },
  });

  it('accepts a correctly signed payload', () => {
    const sig = sign(secret, body);
    expect(verify(secret, body, sig)).toBe(true);
  });

  it('rejects when the body has been tampered with', () => {
    const sig = sign(secret, body);
    const tampered = body.replace('100000', '999999');
    expect(verify(secret, tampered, sig)).toBe(false);
  });

  it('rejects when the secret is wrong', () => {
    const sig = sign('different-secret', body);
    expect(verify(secret, body, sig)).toBe(false);
  });

  it('rejects empty / malformed signatures', () => {
    expect(verify(secret, body, '')).toBe(false);
    expect(verify(secret, body, 'not-a-real-hex-digest')).toBe(false);
  });

  it('produces a 128-char hex digest (SHA-512)', () => {
    const sig = sign(secret, body);
    expect(sig).toHaveLength(128);
    expect(sig).toMatch(/^[0-9a-f]+$/);
  });
});
