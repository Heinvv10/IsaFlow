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
