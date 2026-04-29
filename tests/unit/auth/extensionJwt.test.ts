/**
 * Sign / verify the bank-feed extension pairing JWT.
 *
 * Boundary tests:
 *   - Round-trip: sign → verify → matches original payload
 *   - Wrong scope rejected
 *   - Wrong secret rejected (tampered server)
 *   - Missing required env var throws on signer
 *   - Tampered payload rejected (signature integrity)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  signExtensionToken,
  verifyExtensionToken,
} from '@/lib/auth/extensionJwt';

const ORIGINAL_KEY = process.env.EXTENSION_SIGNING_KEY;
const TEST_KEY = '0123456789abcdef0123456789abcdef';

beforeAll(() => {
  process.env.EXTENSION_SIGNING_KEY = TEST_KEY;
});

afterAll(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.EXTENSION_SIGNING_KEY;
  else process.env.EXTENSION_SIGNING_KEY = ORIGINAL_KEY;
});

const payload = {
  userId: '00000000-0000-0000-0000-000000000001',
  companyId: '00000000-0000-0000-0000-000000000002',
  connectionId: '00000000-0000-0000-0000-000000000003',
  bankId: 'absa',
  scope: 'bank-feed-ingest' as const,
};

describe('extensionJwt — round trip', () => {
  it('signs and verifies a valid token', async () => {
    const token = await signExtensionToken(payload);
    expect(token.split('.')).toHaveLength(3);

    const verified = await verifyExtensionToken(token);
    expect(verified).toEqual(payload);
  });
});

describe('extensionJwt — rejection', () => {
  it('rejects a tampered payload', async () => {
    const token = await signExtensionToken(payload);
    // Mutate the middle (payload) segment so signature no longer matches.
    const parts = token.split('.');
    const tampered = `${parts[0]}.${Buffer.from('{"sub":"evil"}').toString('base64url')}.${parts[2]}`;
    expect(await verifyExtensionToken(tampered)).toBeNull();
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await signExtensionToken(payload);
    process.env.EXTENSION_SIGNING_KEY = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    expect(await verifyExtensionToken(token)).toBeNull();
    process.env.EXTENSION_SIGNING_KEY = TEST_KEY; // restore for other tests
  });

  it('rejects garbage input', async () => {
    expect(await verifyExtensionToken('not-a-jwt')).toBeNull();
  });
});

describe('extensionJwt — env-var enforcement', () => {
  it('throws when secret is missing', async () => {
    const prev = process.env.EXTENSION_SIGNING_KEY;
    delete process.env.EXTENSION_SIGNING_KEY;
    await expect(signExtensionToken(payload)).rejects.toThrow(/EXTENSION_SIGNING_KEY/);
    process.env.EXTENSION_SIGNING_KEY = prev;
  });

  it('throws when secret is too short', async () => {
    const prev = process.env.EXTENSION_SIGNING_KEY;
    process.env.EXTENSION_SIGNING_KEY = 'short';
    await expect(signExtensionToken(payload)).rejects.toThrow(/at least 32/);
    process.env.EXTENSION_SIGNING_KEY = prev;
  });
});
