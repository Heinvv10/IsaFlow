/**
 * Shared seed for the header-account guard suites (gl/headerAccountGuard): the
 * late-claim fixture company with a route user and the accounts the rule tells
 * apart. Every "header" below has a CHILD account under it:
 *   assetHdr (asset, level 1) · liabHdr (liability, level 2) · equityHdr (equity, level 1)
 *   expenseHdr (expense, level 1) · revenueHdr (revenue, level 2)
 *   assetL3 (asset, level 3 — the level arm: it keeps its place on the balance sheet)
 * and `leaf` is a childless level-1 asset, which is what a Sage-imported leaf looks like.
 */
import { sql } from '@/lib/neon';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import { dropLateFixture, seedLateFixture, type LateFixture } from './vatLateClaimFixture';
import { dropRouteUser, seedRouteUser } from './vatLateClaimRoutes';

type Row = Record<string, unknown>;

export interface HeaderAccount { id: string; code: string; childId: string }

export interface HeaderFixture {
  fx: LateFixture;
  token: string;
  assetHdr: HeaderAccount;
  liabHdr: HeaderAccount;
  equityHdr: HeaderAccount;
  expenseHdr: HeaderAccount;
  revenueHdr: HeaderAccount;
  assetL3: HeaderAccount;
  leaf: string;
}

export interface NewAccount {
  code: string; type: string; level: number; parentId?: string | null; subtype?: string | null; system?: boolean;
}

/** One account in the fixture company. Credit-normal for liability/equity/revenue. */
export async function addAccount(fx: LateFixture, a: NewAccount): Promise<string> {
  const normal = ['liability', 'equity', 'revenue'].includes(a.type) ? 'credit' : 'debit';
  const id = String(((await sql`
    INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype,
                             normal_balance, is_active, is_system_account, level, parent_account_id)
    VALUES (${fx.companyId}::UUID, ${a.code}, ${`${a.code} name ${fx.tag}`}, ${a.type}, ${a.subtype ?? null},
            ${normal}, true, ${a.system ?? false}, ${a.level}, ${a.parentId ?? null}::UUID)
    RETURNING id`) as Row[])[0]!.id);
  clearSystemAccountCache(fx.companyId);
  return id;
}

/** An account with one child under it. */
export async function addHeader(fx: LateFixture, code: string, type: string, level: number): Promise<HeaderAccount> {
  const id = await addAccount(fx, { code, type, level });
  const childId = await addAccount(fx, { code: `${code}.1`, type, level: level + 1, parentId: id });
  return { id, code, childId };
}

export async function seedHeaderFixture(prefix: string, databaseUrl: string): Promise<HeaderFixture> {
  const fx = await seedLateFixture(prefix, databaseUrl);
  const token = await seedRouteUser(fx, prefix.toLowerCase());
  return {
    fx, token,
    assetHdr: await addHeader(fx, 'HG-A1', 'asset', 1),
    liabHdr: await addHeader(fx, 'HG-L2', 'liability', 2),
    equityHdr: await addHeader(fx, 'HG-E1', 'equity', 1),
    expenseHdr: await addHeader(fx, 'HG-X1', 'expense', 1),
    revenueHdr: await addHeader(fx, 'HG-R2', 'revenue', 2),
    assetL3: await addHeader(fx, 'HG-A3', 'asset', 3),
    leaf: await addAccount(fx, { code: 'HG-LEAF', type: 'asset', level: 1 }),
  };
}

export async function dropHeaderFixture(h: HeaderFixture | undefined): Promise<void> {
  if (!h) return;
  const c = h.fx.companyId;
  await sql`DELETE FROM recurring_journals WHERE company_id = ${c}::UUID`;
  await sql`DELETE FROM recurring_transaction_templates WHERE company_id = ${c}::UUID`;
  await sql`DELETE FROM reclassification_batch_lines WHERE company_id = ${c}::UUID`;
  await sql`DELETE FROM reclassification_batches WHERE company_id = ${c}::UUID`;
  await sql`DELETE FROM assets WHERE company_id = ${c}::UUID`;
  await dropRouteUser(h.fx);
  await dropLateFixture(h.fx);
}
