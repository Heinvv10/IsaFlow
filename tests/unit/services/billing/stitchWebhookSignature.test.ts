/**
 * Unit tests for the Stitch/Svix webhook signature verifier.
 * We copy the signing algorithm directly from the handler so this test
 * also doubles as a spec: any change to the handler's verify code should
 * show up here as a diff.
 */

import { describe, it, expect } from 'vitest';
import { createHmac, timingSafeEqual } from 'crypto';

function sign(secret: string, svixId: string, svixTimestamp: string, body: string): string {
  const secretBytes = secret.startsWith('whsec_')
    ? Buffer.from(secret.slice(6), 'base64')
    : Buffer.from(secret, 'base64');
  const signed = `${svixId}.${svixTimestamp}.${body}`;
  const hash = createHmac('sha256', secretBytes).update(signed).digest('base64');
  return `v1,${hash}`;
}

function verify(secret: string, svixId: string, svixTimestamp: string, body: string, header: string): boolean {
  const secretBytes = secret.startsWith('whsec_')
    ? Buffer.from(secret.slice(6), 'base64')
    : Buffer.from(secret, 'base64');
  const expected = createHmac('sha256', secretBytes).update(`${svixId}.${svixTimestamp}.${body}`).digest('base64');
  for (const part of header.split(' ')) {
    const [, sig] = part.split(',');
    if (!sig) continue;
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  return false;
}

describe('Stitch Svix signature verification', () => {
  const secret = 'whsec_' + Buffer.from('this-is-a-32-byte-secret-string!').toString('base64');
  const svixId = 'msg_2abcDEF';
  const svixTimestamp = '1712345678';
  const body = JSON.stringify({ eventType: 'PaymentInitiationCompleted', payload: { id: 'pir_1' } });

  it('accepts a correctly signed payload', () => {
    const header = sign(secret, svixId, svixTimestamp, body);
    expect(verify(secret, svixId, svixTimestamp, body, header)).toBe(true);
  });

  it('rejects a tampered body', () => {
    const header = sign(secret, svixId, svixTimestamp, body);
    const tampered = body.replace('pir_1', 'pir_EVIL');
    expect(verify(secret, svixId, svixTimestamp, tampered, header)).toBe(false);
  });

  it('rejects a mismatched timestamp', () => {
    const header = sign(secret, svixId, svixTimestamp, body);
    expect(verify(secret, svixId, '1000000000', body, header)).toBe(false);
  });

  it('rejects an empty header', () => {
    expect(verify(secret, svixId, svixTimestamp, body, '')).toBe(false);
  });

  it('accepts a header with multiple space-separated signatures (key rotation)', () => {
    const oldSecret = 'whsec_' + Buffer.from('old-32-byte-secret-string-abcdefg').toString('base64');
    const realSig = sign(secret, svixId, svixTimestamp, body);
    const oldSig = sign(oldSecret, svixId, svixTimestamp, body);
    const combined = `${oldSig} ${realSig}`;
    expect(verify(secret, svixId, svixTimestamp, body, combined)).toBe(true);
  });
});
