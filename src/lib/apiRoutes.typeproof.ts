/**
 * COMPILE-TIME PROOF for the route→type registry. This file has no runtime
 * behaviour and is never imported; `bun run type-check` is what executes it.
 *
 * It must live under `src/` because `tsconfig` excludes `tests/**` — a type
 * proof placed there would never be checked and would be decorative, which is
 * the failure mode recorded in `feedback_mutation_proof_not_assertion`.
 *
 * Each `@ts-expect-error` below asserts that a REAL production bug is now a
 * compile error. TypeScript reports TS2578 for an unused directive, so if a
 * guarantee ever regresses — the registry drifting from the service, or
 * `apiJson` degrading to `any` — the suppression becomes unused and the build
 * FAILS. That two-way property is what makes this a proof rather than a
 * comment: verified 2026-08-17 by deleting a directive and observing
 * `TS2339: Property 'id' does not exist on type '{ session: MigrationSession | null }'`.
 */

import { apiJson } from '@/lib/apiFetch';
import type { CommentaryRow } from '@/modules/accounting/services/commentary/commentaryService';
import type { Currency } from '@/modules/accounting/services/core/currencyService';

// 1. Registered static route infers the real service type.
export async function p1() {
  const cur = await apiJson('/api/accounting/currencies');
  const ok: Currency[] = cur;      // must compile
  return ok;
}

// 2. A WRONG FIELD NAME must be a compile error (this is the whole point).
export async function p2() {
  const cur = await apiJson('/api/accounting/currencies');
  // @ts-expect-error `nope` does not exist on Currency
  return cur[0]!.nope;
}

// 3. The real bug #4-6 shape: reading `.id` off the session envelope must fail.
export async function p3() {
  const s = await apiJson('/api/accounting/migration/session');
  // @ts-expect-error the envelope is { session }, never { id } — this WAS the live bug
  return s.id;
}

// 4. ...and the correct read must compile.
export async function p4() {
  const s = await apiJson('/api/accounting/migration/session');
  return s.session?.id;
}

// 5. Query strings must not defeat route matching (the VAT widget uses them).
export async function p5() {
  const v = await apiJson('/api/accounting/reports-vat-return?period_start=a&period_end=b');
  // @ts-expect-error output_vat is the snake_case guess that made the widget read R0.00
  return v.output_vat;
}

// 6. Dynamic segment resolves through a template literal.
export async function p6(id: string) {
  const r = await apiJson(`/api/admin/users/${id}/impersonate`, { method: 'POST' });
  const redirect: string = r.redirect;   // must compile
  // @ts-expect-error there is never a token — this WAS the live Login-As bug
  return [redirect, r.token];
}

// 7. An UNREGISTERED route must be `unknown`, not `any`.
export async function p7() {
  const u = await apiJson('/api/accounting/not-registered-anywhere');
  // @ts-expect-error unknown is not indexable — forces the caller to register or narrow
  return u.anything;
}

// 8. The dynamic segment binds ONE path segment only. A deeper path that merely
//    shares the prefix and suffix must NOT inherit the impersonate type — that
//    would be this registry recreating the very defect it exists to prevent.
export async function p8() {
  const other = await apiJson('/api/admin/users/abc/roles/impersonate');
  // @ts-expect-error must resolve to `unknown`, NOT to { redirect: string }
  return other.redirect;
}

// 9. A query string must not defeat the dynamic matcher either.
export async function p9(id: string) {
  const r = await apiJson(`/api/admin/users/${id}/impersonate?foo=1`, { method: 'POST' });
  const redirect: string = r.redirect;
  return redirect;
}

// 10. WS3: a union-registered path must FORCE narrowing. Reading the list field
//     straight off the union is the shape a POST caller would write, and it
//     must not compile — that is the whole reason the union is safe to register.
export async function p10() {
  const r = await apiJson('/api/accounting/annotations?rowIds=acc:4000&from=a&to=b');
  // @ts-expect-error the POST arm has no `annotations`; the caller must narrow first
  return r.annotations;
}

// 11. ...and narrowing must reach the real service type on both arms.
export async function p11() {
  const r = await apiJson('/api/accounting/annotations?rowIds=acc:4000&from=a&to=b');
  if ('annotations' in r) return r.annotations[0]?.rowId;
  return r.annotation.rowId;
}

// 12. The share-link POST arm carries the raw token; the GET arm cannot. A
//     caller that reads `token` without narrowing is the leak-shaped mistake.
export async function p12() {
  const r = await apiJson('/api/accounting/share/links', { method: 'POST' });
  // @ts-expect-error the GET arm has no `token` — narrow before reading it
  return r.token;
}

// 13. WS3 dynamic routes resolve through a template literal, one segment only.
export async function p13(id: string) {
  const r = await apiJson(`/api/accounting/annotations/${id}/resolve`, { method: 'POST' });
  const resolved: boolean = r.resolved;
  // @ts-expect-error resolve answers a boolean and nothing else
  return [resolved, r.annotation];
}

// 14. The commentary verbs infer the service's own row type, so a snake_case
//     guess at its fields is a compile error rather than a silent undefined.
export async function p14(id: string) {
  const r = await apiJson(`/api/accounting/commentary/${id}/approve`, { method: 'POST' });
  // @ts-expect-error the row is camelCase `approvedText`, never `approved_text`
  return [r.commentary.approvedText, r.commentary.approved_text];
}

// 15. A union's arms must stay DISJOINT on the key callers narrow by. After
//     `'commentary' in r` the caller must hold the LIST arm and nothing else.
//     If `generateDrafts` ever returns a `commentary` key, this assignment
//     stops compiling — which is the alarm, since every `in` check on this
//     route would otherwise keep compiling while no longer discriminating.
export async function p15() {
  const r = await apiJson('/api/accounting/commentary?type=board&from=a&to=b');
  if (!('commentary' in r)) return null;
  const rows: CommentaryRow[] = r.commentary;
  return rows[0]?.sectionRef ?? null;
}

// 16. Same pin from the other side: narrowing AWAY from the list arm must
//     leave the generate arm alone, with its own two fields and no third.
export async function p16() {
  const r = await apiJson('/api/accounting/commentary?type=board&from=a&to=b');
  if ('commentary' in r) return null;
  const written: number = r.written;
  const skipped: string[] = r.skipped;
  return [written, skipped.length] as const;
}

// 17. And the same condition on the share-links union, whose arms are the one
//     that carries the raw token and the one that must never be able to.
export async function p17() {
  const r = await apiJson('/api/accounting/share/links');
  if (!('links' in r)) return null;
  // @ts-expect-error the LIST arm has no token — if it ever gains one, this
  // line starts compiling and the expect-error itself fails the build.
  return r.token;
}
