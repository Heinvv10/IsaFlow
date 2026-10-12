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
  it('a seal under a retired key verifies with that key; under a key id the server holds no key for it is invalid', () => {
    const { hmac, keyId } = sign(SNAPSHOT_SEAL_DOMAIN, fields, KEY);
    const rotated = { key: Buffer.from('r'.repeat(40)), keyId: 'test-2', retired: new Map([[keyId, { key: KEY.key, retiredAt: Date.parse('2030-01-01T00:00:00Z') }]]) };
    expect(checkSeal(SNAPSHOT_SEAL_DOMAIN, fields, hmac, keyId, rotated)).toBe('valid');
    expect(checkSeal(SNAPSHOT_SEAL_DOMAIN, { ...fields, cutoff: '2026-07-01' }, hmac, keyId, rotated)).toBe('invalid');
    expect(checkSeal(SNAPSHOT_SEAL_DOMAIN, fields, hmac, keyId, { ...rotated, retired: new Map() })).toBe('invalid');
    // Signed with the CURRENT key but naming a key id the server does not hold: the id picks the key, so invalid.
    const underCurrent = sign(SNAPSHOT_SEAL_DOMAIN, fields, rotated).hmac;
    expect(checkSeal(SNAPSHOT_SEAL_DOMAIN, fields, underCurrent, 'never-issued', rotated)).toBe('invalid');
    expect(checkSeal(SNAPSHOT_SEAL_DOMAIN, fields, underCurrent, 'test-2', rotated)).toBe('valid');
    // The same retired id with a different secret (a forger naming a real id) does not verify either.
    expect(checkSeal(SNAPSHOT_SEAL_DOMAIN, fields, sign(SNAPSHOT_SEAL_DOMAIN, fields, { key: Buffer.from('f'.repeat(40)), keyId }).hmac,
      keyId, rotated)).toBe('invalid');
  });
  it('a retired key vouches only for seals taken before it was retired: a forgery under a leaked key after rotation is invalid (breaker r2 N8)', () => {
    const { hmac, keyId } = sign(SNAPSHOT_SEAL_DOMAIN, fields, KEY);
    const retiredAt = (iso: string) => ({ key: Buffer.from('r'.repeat(40)), keyId: 'test-2', retired: new Map([[keyId, { key: KEY.key, retiredAt: Date.parse(iso) }]]) });
    expect(Date.parse(fields.takenAt)).toBeLessThan(Date.parse('2027-01-01T00:00:00Z'));
    expect(checkSeal(SNAPSHOT_SEAL_DOMAIN, fields, hmac, keyId, retiredAt('2027-01-01T00:00:00Z'))).toBe('valid');
    // Retired before this seal's taken_at: whoever signed it held a key that was already retired.
    expect(checkSeal(SNAPSHOT_SEAL_DOMAIN, fields, hmac, keyId, retiredAt(fields.takenAt))).toBe('invalid');
    expect(checkSeal(SNAPSHOT_SEAL_DOMAIN, fields, hmac, keyId, retiredAt('2020-01-01T00:00:00Z'))).toBe('invalid');
    // A pack passes the database's built_at: the taken_at inside its manifest is the forger's to write.
    expect(checkSeal(SNAPSHOT_SEAL_DOMAIN, fields, hmac, keyId, retiredAt('2027-01-01T00:00:00Z'), '2027-06-01T00:00:00Z')).toBe('invalid');
    expect(checkSeal(SNAPSHOT_SEAL_DOMAIN, fields, hmac, keyId, retiredAt('2027-01-01T00:00:00Z'), '2026-12-31T23:59:59Z')).toBe('valid');
    expect(checkSeal(SNAPSHOT_SEAL_DOMAIN, fields, hmac, keyId, retiredAt('2027-01-01T00:00:00Z'), '')).toBe('invalid');
    // The current key does not care when.
    expect(checkSeal(SNAPSHOT_SEAL_DOMAIN, fields, hmac, keyId, KEY, '2099-01-01T00:00:00Z')).toBe('valid');
  });
  it('the chain position is signed: another seq or previous link does not verify', () => {
    const chained = { ...fields, chain: { seq: 2, prevHmac: 'c'.repeat(64) } };
    const { hmac, keyId } = sign(SNAPSHOT_SEAL_DOMAIN, chained, KEY);
    expect(sealMessage(SNAPSHOT_SEAL_DOMAIN, chained)).toMatch(/\|2\|c{64}$/);
    expect(checkSeal(SNAPSHOT_SEAL_DOMAIN, chained, hmac, keyId, KEY)).toBe('valid');
    expect(checkSeal(SNAPSHOT_SEAL_DOMAIN, { ...fields, chain: { seq: 3, prevHmac: 'c'.repeat(64) } }, hmac, keyId, KEY)).toBe('invalid');
    expect(checkSeal(SNAPSHOT_SEAL_DOMAIN, { ...fields, chain: { seq: 2, prevHmac: null } }, hmac, keyId, KEY)).toBe('invalid');
  });
  it('the key comes from the environment and must be long enough and named', () => {
    process.env.AUDIT_SNAPSHOT_SIGNING_KEY = 'short';
    process.env.AUDIT_SNAPSHOT_KEY_ID = 'k';
    expect(() => signingKey()).toThrow(SigningKeyMissingError);
    process.env.AUDIT_SNAPSHOT_SIGNING_KEY = 'x'.repeat(32);
    process.env.AUDIT_SNAPSHOT_KEY_ID = ' ';
    expect(() => signingKey()).toThrow(SigningKeyMissingError);
    process.env.AUDIT_SNAPSHOT_KEY_ID = 'k2';
    process.env.AUDIT_SNAPSHOT_RETIRED_KEYS = `k0=${'a'.repeat(32)}@2026-10-12T14:00:00Z, `;
    const k = signingKey();
    expect(k.keyId).toBe('k2');
    expect([...k.retired!.keys()]).toEqual(['k0']);
    expect(k.retired!.get('k0')).toEqual({ key: Buffer.from('a'.repeat(32)), retiredAt: Date.parse('2026-10-12T14:00:00Z') });
    // Any malformed entry is a configuration error (breaker r3 K1), never skipped into every old seal reading forged.
    for (const bad of ['k1=short@2026-10-12T14:00:00Z', `k2=${'b'.repeat(32)}@2026-10-12T14:00:00Z`, `k3=${'c'.repeat(32)}`,
      `k4=${'d'.repeat(32)}@yesterday`, 'junk']) {
      process.env.AUDIT_SNAPSHOT_RETIRED_KEYS = `k0=${'a'.repeat(32)}@2026-10-12T14:00:00Z,${bad}`;
      expect(() => signingKey(), bad).toThrow(/AUDIT_SNAPSHOT_RETIRED_KEYS/);
    }
    process.env.AUDIT_SNAPSHOT_RETIRED_KEYS = '';
  });
});
