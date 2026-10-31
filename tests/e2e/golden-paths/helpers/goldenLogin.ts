/**
 * One golden login: as the slot's user, scoped to the slot's company, or (no slot) as E2E_ADMIN_* in its default company.
 * Shared by the suite's global setup and by Api.login's fallback for single-spec runs.
 */
import type { APIRequestContext } from '@playwright/test';
import { getE2ECredentials } from '../../_creds';
import type { GoldenSlot } from './goldenSlot';

const CSRF_COOKIE = 'isaflow_csrf';

async function csrfToken(ctx: APIRequestContext): Promise<string> {
  return (await ctx.storageState()).cookies.find((c) => c.name === CSRF_COOKIE)?.value ?? '';
}

async function activeCompanyId(ctx: APIRequestContext): Promise<string> {
  const res = await ctx.get('/api/accounting/companies?action=user-companies');
  const body = await res.json().catch(() => null);
  return String(body?.data?.activeCompanyId ?? '');
}

/**
 * Logs `ctx` in. The caller reads the CSRF cookie afterwards; the middleware issues it on any routed request, which is
 * what the GET below is for. With a slot the session is then pointed at the slot company through the app's own
 * switch-company route and read back, so a login that landed in another company fails here and not in some spec.
 */
export async function loginGolden(ctx: APIRequestContext, slot: GoldenSlot | null): Promise<void> {
  const { email, password } = slot ?? getE2ECredentials();
  const res = await ctx.post('/api/auth/login', { data: { email, password } });
  if (res.status() !== 200) {
    throw new Error(`golden-paths login failed: ${res.status()} ${await res.text()}`);
  }
  await ctx.get('/accounting');
  if (!slot) return;

  const csrf = await csrfToken(ctx);
  if (!csrf) throw new Error('golden slot: no CSRF cookie after login, cannot switch company');
  const switched = await ctx.post('/api/auth/switch-company', {
    data: { companyId: slot.companyId },
    headers: { 'x-csrf-token': csrf },
  });
  if (switched.status() !== 200) {
    throw new Error(`golden slot: switch to slot company ${slot.companyId} failed: ${switched.status()} ${await switched.text()}. Is ${slot.email} a member of it (scripts/ci/golden/provision-slots.ts)?`);
  }
  const active = await activeCompanyId(ctx);
  if (active !== slot.companyId) {
    throw new Error(`golden slot: session is scoped to ${active || 'no company'}, not the slot company ${slot.companyId}`);
  }
}
