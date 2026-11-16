/**
 * erasedUserEmail: the POPIA erasure placeholder must be lower-case and distinct per user id even once
 * lower-cased (users_email_lower_key, migration 999). The route itself: tests/integration/s07c-lows.
 */
import { describe, expect, it } from 'vitest';
import { erasedUserEmail } from '@/lib/auth/usersEmailUnique';

const hex = (s: string) => Buffer.from(s, 'utf8').toString('hex');

describe('erasedUserEmail', () => {
  it('a lower-case id (every GoTrue id) keeps the plain form', () => {
    const id = '0f8a2c1e-3b4d-4e5f-8a9b-0c1d2e3f4a5b';
    expect(erasedUserEmail(id)).toBe(`anonymized_${id}@deleted.invalid`);
  });

  it('an id with upper-case letters is hex-encoded with an _h suffix', () => {
    expect(erasedUserEmail('AB')).toBe(`anonymized_${hex('AB')}_h@deleted.invalid`);
  });

  it('distinct ids give distinct lower-case addresses: case twins, and a plain id spelling another id\'s encoding', () => {
    const ids = ['0f8a2c1e-aaaa', '0F8A2C1E-AAAA', '0f8A2c1e-aaaa', 'AB', `${hex('AB')}_h`, 'x_h', 'X_h'];
    const out = ids.map((id) => erasedUserEmail(id));
    for (const e of out) expect(e).toBe(e.trim().toLowerCase());
    expect(new Set(out.map((e) => e.toLowerCase())).size).toBe(ids.length);
  });
});
