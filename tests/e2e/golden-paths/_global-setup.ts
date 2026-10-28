/**
 * Golden-paths global setup — logs in ONCE per suite run and saves the
 * storage state (session + CSRF cookies) for every spec to reuse.
 *
 * One login per run matters: /api/auth/login is rate-limited to 10 attempts
 * per email per 15 minutes. Eleven specs logging in individually would spend
 * the whole window on a single run (and break post-deploy verification
 * against prod Demo).
 *
 * In CI the job sets GOLDEN_COMPANY_ID/_USER_EMAIL/_USER_PASSWORD (see helpers/goldenSlot.ts) and the login is the
 * slot user's, switched into the slot company. Without them nothing changes: E2E_ADMIN_*, that user's default company.
 */
import { request as pwRequest, type FullConfig } from '@playwright/test';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { loginGolden } from './helpers/goldenLogin';
import { readGoldenSlot } from './helpers/goldenSlot';

export const GOLDEN_STATE_FILE = 'tests/e2e/.auth/golden-session.json';

export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use?.baseURL;
  if (!baseURL) throw new Error('golden config must define use.baseURL');

  const ctx = await pwRequest.newContext({ baseURL });
  await loginGolden(ctx, readGoldenSlot(process.env));

  // Precondition: GL-on-approve needs the company's system-account mappings.
  // Fail HERE with an actionable message instead of letting spec b/c/e fail
  // mysteriously on an environment whose Demo company is missing them (dev
  // Demo was, until 2026-07-05 — see the baseline doc).
  const missing: string[] = [];
  for (const subtype of [
    'receivable',
    'default_revenue',
    'vat_output',
    'payable',
    'vat_input',
    'default_expense',
  ]) {
    const res2 = await ctx.get(`/api/accounting/chart-of-accounts?subtype=${subtype}`);
    const body = await res2.json().catch(() => null);
    const accounts = body?.data ?? [];
    // The resolver requires is_system_account=true as well as the subtype.
    const ok =
      Array.isArray(accounts) && accounts.some((a: any) => a.isSystemAccount === true);
    if (!ok) missing.push(subtype);
  }
  if (missing.length > 0) {
    throw new Error(
      `golden-paths precondition failed: company has no system account for [${missing.join(', ')}]. ` +
        `Set account_subtype + is_system_account on the chart of accounts (mirror prod Demo: 1120 receivable, 4100 default_revenue, 2120 vat_output).`,
    );
  }

  mkdirSync(dirname(GOLDEN_STATE_FILE), { recursive: true });
  await ctx.storageState({ path: GOLDEN_STATE_FILE });
  await ctx.dispose();
}
