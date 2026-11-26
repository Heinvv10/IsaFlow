/**
 * Wave 7 AAa: a pinned actor-site or VALUES line may not carry a uuid cast of its own. Re-pinning a line after a `::uuid`
 * (or CAST, ARRAY[..]::uuid[], (..)::uuid) was added to it must fail here, not only in the exact-text pin: once a line
 * is stripped of its listed non-actor id casts, the word uuid is not left, unless the line is a pinned author-array
 * exemption. See actorIdTextCensus.test.ts for the census these pins belong to.
 */
import { describe, expect, it } from 'vitest';
import { AP_AR_SITES, AP_AR_UUID_AUTHOR_EXEMPT, AP_AR_VALUE_BINDS, apArNonActorOk } from './apArCensusData';

const pinned = (m: Record<string, Record<number, string>>) =>
  Object.entries(m).flatMap(([f, ls]) => Object.entries(ls).map(([n, text]) => ({ f, n: Number(n), text })));
/** The only shapes a pinned uuid cast of an actor-shaped value may have: uuid[] author arrays and the regex-guarded created_by cast. */
const AUTHOR_SHAPE = /approval_add_author\(|^ARRAY\[\$\{userId\}::UUID\]$|THEN t\.created_by::UUID END|^SELECT DISTINCT a FROM unnest\(\$\{authors\}::UUID\[\]\)/;
/** A `${expr}` that names an actor, and what a bare actor looks like. */
const ACTOR_EXPR = /\$\{([^}]*\b(?:userId|createdBy|actorId|approverUserId|processedBy|approvedBy|editedBy|user\.id|actor\.userId)\b[^}]*)\}/g;
const BARE = /^[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*$/;
const left = (text: string, f: string) => text.replace(/\$\{([^}]*)\}\s*::\s*"?(?:pg_catalog\.)?"?uuid"?(\[\])?/gi, (m, e: string) => (apArNonActorOk(e.trim(), f) ? '' : m));

describe('pinned AP/AR lines carry no actor uuid cast (AAa)', () => {
  for (const [name, m] of [['actor-column', AP_AR_SITES], ['VALUES', AP_AR_VALUE_BINDS]] as const) {
    it(`no pinned ${name} line has a uuid cast left after its listed non-actor id casts are removed`, () => {
      const bad = pinned(m).filter(({ f, n, text }) => /uuid/i.test(left(text, f)) && !(AP_AR_UUID_AUTHOR_EXEMPT[f]?.[n] === text && AUTHOR_SHAPE.test(text)));
      expect(bad.map(({ f, n }) => `${f}:${n}`)).toEqual([]);
    });
  }
  it('the actor in a pinned line is a bare identifier or property path, never a call (`${asActor(userId)}`)', () => {
    const calls = pinned({ ...AP_AR_SITES, ...AP_AR_VALUE_BINDS }).flatMap(({ f, n, text }) =>
      [...text.matchAll(ACTOR_EXPR)].map((m) => m[1]!.trim()).filter((e) => !BARE.test(e)).map((e) => `${f}:${n} ${e}`));
    expect(calls).toEqual([]);
    expect([...'${asActor(userId)}'.matchAll(ACTOR_EXPR)].map((m) => m[1]!.trim()).filter((e) => !BARE.test(e))).toEqual(['asActor(userId)']);
  });
  it('the exempt shapes are only the author arrays', () => {
    expect(AUTHOR_SHAPE.test('ARRAY[${userId}]::uuid[]')).toBe(false);
    expect(AUTHOR_SHAPE.test('ARRAY[${userId}::UUID]')).toBe(true);
  });
  it('the check sees a re-pinned cast (not dead)', () => {
    expect(/uuid/i.test(left('${a}, ${userId}::uuid', 'x.ts'))).toBe(true);
    expect(/uuid/i.test(left('ARRAY[${userId}]::uuid[]', 'x.ts'))).toBe(true);
    expect(/uuid/i.test(left('${companyId}::UUID, ${userId}', 'x.ts'))).toBe(false);
    expect(/uuid/i.test(left('${id}::UUID, ${userId}', 'x.ts'))).toBe(true);
  });
});
