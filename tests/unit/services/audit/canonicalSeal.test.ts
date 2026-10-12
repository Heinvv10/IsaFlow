import { afterEach, describe, expect, it } from 'vitest';
import { CanonicalValueError, canonicalJson, materialHash, sha256Hex } from '@/modules/accounting/services/audit/canonical';
import {
  SNAPSHOT_SEAL_DOMAIN, CHECK_RUN_SEAL_DOMAIN, SigningKeyMissingError, checkSeal, sealMessage, sign, signingKey,
} from '@/modules/accounting/services/audit/seal';

const KEY = { key: Buffer.from('k'.repeat(40)), keyId: 'test-1' };
const fields = { companyId: 'c', id: 'i', canonicalHash: 'a'.repeat(64), cutoff: '2026-06-30', takenAt: '2026-07-01T10:00:00.123456Z' };

describe('canonicalJson', () => {
  it('orders keys at every depth and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1], c: 'x' } })).toBe('{"a":{"c":"x","d":[3,1]},"b":1}');
  });
  it('is the same for the same value however its keys were inserted', () => {
    expect(canonicalJson({ x: '1.00', y: null })).toBe(canonicalJson({ y: null, x: '1.00' }));
  });
  it('drops undefined members, keeps null', () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
  });
  it('refuses fractional numbers and Dates — amounts and timestamps are strings', () => {
    expect(() => canonicalJson({ amount: 10.5 })).toThrow(CanonicalValueError);
    expect(() => canonicalJson({ at: new Date() })).toThrow(/Date/);
    expect(() => canonicalJson({ n: 2 ** 60 })).toThrow(/safe integer/);
  });
  it('survives a JSONB-style round trip (parse of the canonical text)', () => {
    const row = { z: '100.00', a: ['x', { q: 1, p: null }], m: true };
    expect(canonicalJson(JSON.parse(canonicalJson(row)))).toBe(canonicalJson(row));
  });
  it('escapes strings exactly as JSON does', () => {
    expect(canonicalJson({ s: 'a"b\n' })).toBe('{"s":"a\\"b\\n"}');
  });
});

describe('hashes', () => {
  it('sha256Hex is SHA-256', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  it('a material hash moves with any field and not with key order', () => {
    const base = materialHash({ id: '1', debit: '10.00', credit: '0.00' });
    expect(materialHash({ credit: '0.00', debit: '10.00', id: '1' })).toBe(base);
    expect(materialHash({ id: '1', debit: '10.01', credit: '0.00' })).not.toBe(base);
  });
});

describe('seal', () => {
  const env = { ...process.env };
  afterEach(() => { process.env = { ...env }; });

  it('binds the domain and every field in order', () => {
    expect(sealMessage(SNAPSHOT_SEAL_DOMAIN, fields)).toBe(
      `isaflow:audit-snapshot:v1|c|i|${'a'.repeat(64)}|2026-06-30|2026-07-01T10:00:00.123456Z`);
  });
  it('verifies its own seal and refuses any change to a field, the domain or the hmac', () => {
    const { hmac, keyId } = sign(SNAPSHOT_SEAL_DOMAIN, fields, KEY);
    expect(checkSeal(SNAPSHOT_SEAL_DOMAIN, fields, hmac, keyId, KEY)).toBe('valid');
    for (const k of Object.keys(fields) as (keyof typeof fields)[]) {
      expect(checkSeal(SNAPSHOT_SEAL_DOMAIN, { ...fields, [k]: `${fields[k]}x` }, hmac, keyId, KEY), k).toBe('invalid');
    }
    expect(checkSeal(CHECK_RUN_SEAL_DOMAIN, fields, hmac, keyId, KEY)).toBe('invalid');
    const flipped = `${hmac.slice(0, 63)}${hmac.endsWith('0') ? '1' : '0'}`;
    expect(checkSeal(SNAPSHOT_SEAL_DOMAIN, fields, flipped, keyId, KEY)).toBe('invalid');
    expect(checkSeal(SNAPSHOT_SEAL_DOMAIN, fields, 'not-hex', keyId, KEY)).toBe('invalid');
    expect(checkSeal(SNAPSHOT_SEAL_DOMAIN, fields, hmac, keyId, { key: Buffer.from('z'.repeat(40)), keyId })).toBe('invalid');
  });
  it('a seal made under another key id is unknown, not invalid', () => {
    const { hmac } = sign(SNAPSHOT_SEAL_DOMAIN, fields, KEY);
    expect(checkSeal(SNAPSHOT_SEAL_DOMAIN, fields, hmac, 'old-key', KEY)).toBe('unknown_key');
  });
  it('the key comes from the environment and must be long enough and named', () => {
    process.env.AUDIT_SNAPSHOT_SIGNING_KEY = 'short';
    process.env.AUDIT_SNAPSHOT_KEY_ID = 'k';
    expect(() => signingKey()).toThrow(SigningKeyMissingError);
    process.env.AUDIT_SNAPSHOT_SIGNING_KEY = 'x'.repeat(32);
    process.env.AUDIT_SNAPSHOT_KEY_ID = ' ';
    expect(() => signingKey()).toThrow(SigningKeyMissingError);
    process.env.AUDIT_SNAPSHOT_KEY_ID = 'k2';
    expect(signingKey().keyId).toBe('k2');
  });
});
