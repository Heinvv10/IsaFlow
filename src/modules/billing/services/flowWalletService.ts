/**
 * PAYG Flow Wallet service.
 *
 * Owns every mutation of `flow_wallet`, `flow_ledger`, and `flow_purchases`.
 * Each mutating call is atomic: the balance update and the ledger row are
 * written in the same transaction, so `flow_ledger` always has exactly one
 * row per balance change and `balance_after` on the most-recent ledger row
 * always equals `flow_wallet.balance_flows`.
 *
 * No app role may write these tables (S-07e, migration 945): every mutation
 * runs in its own migration_admin transaction (`migrationAdminSqlTx`), keyed
 * on a company id or purchase id the caller verified, and COMMITs on its own,
 * not with the request that made it. A caller that must undo one (a refund
 * after a failed handler) calls the inverse mutation. `adminAdjust` is the one
 * exception: it runs on the platform_admin request's transaction.
 * Purchases live in flowPurchaseService.ts, debit, refund and adjust in
 * flowWalletMutations.ts, the shared statements in flowWalletTx.ts; all are
 * re-exported here.
 *
 * Spec: docs/superpowers/specs/2026-04-19-payg-flows-pricing-design.md §5
 */

import { sql } from '@/lib/neon';
import { migrationAdminSqlTx } from '@/lib/auth/migrationAdminPool';
import { ensureWalletRow } from './flowWalletTx';

export type LedgerType = 'purchase' | 'debit' | 'refund' | 'admin_adjustment';
export type NudgeLevel = 'none' | 'yellow' | 'orange' | 'red';

export interface FlowWallet {
  companyId: string;
  balance: number;
  autoTopupEnabled: boolean;
  autoTopupBundleId: string | null;
  nudgeLevel: NudgeLevel;
  monthFlowsUsed: number;
  monthResetAt: Date;
}

export interface FlowBundle {
  id: string;
  name: string;
  flows: number;
  priceCents: number;
  isActive: boolean;
  displayOrder: number;
}

export interface LedgerEntry {
  id: string;
  type: LedgerType;
  flows: number;
  balanceAfter: number;
  operationCode: string | null;
  referenceId: string | null;
  reason: string | null;
  createdAt: Date;
}

export { InsufficientFlowsError } from './flowWalletTx';
import { computeNudge } from './flowWalletTx';

function mapWallet(row: Record<string, unknown>): FlowWallet {
  return {
    companyId:           row.company_id as string,
    balance:             row.balance_flows as number,
    autoTopupEnabled:    row.auto_topup_enabled as boolean,
    autoTopupBundleId:   (row.auto_topup_bundle_id as string | null) ?? null,
    nudgeLevel:          row.nudge_level as NudgeLevel,
    monthFlowsUsed:      row.month_flows_used as number,
    monthResetAt:        row.month_reset_at as Date,
  };
}

function mapLedger(row: Record<string, unknown>): LedgerEntry {
  return {
    id:            row.id as string,
    type:          row.type as LedgerType,
    flows:         row.flows as number,
    balanceAfter:  row.balance_after as number,
    operationCode: (row.operation_code as string | null) ?? null,
    referenceId:   (row.reference_id as string | null) ?? null,
    reason:        (row.reason as string | null) ?? null,
    createdAt:     row.created_at as Date,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reads
// ─────────────────────────────────────────────────────────────────────────────

export async function getWallet(companyId: string): Promise<FlowWallet | null> {
  // Explicit columns: no app role may read payment_method_token (migration 945).
  const rows = (await sql`
    SELECT company_id, balance_flows, auto_topup_enabled, auto_topup_bundle_id,
           nudge_level, month_flows_used, month_reset_at
      FROM flow_wallet WHERE company_id = ${companyId} LIMIT 1
  `) as Record<string, unknown>[];
  return rows[0] ? mapWallet(rows[0]) : null;
}

export async function listLedger(
  companyId: string,
  limit = 50,
  cursorCreatedAt?: Date,
): Promise<LedgerEntry[]> {
  const rows = cursorCreatedAt
    ? ((await sql`
        SELECT * FROM flow_ledger
         WHERE company_id = ${companyId}
           AND created_at < ${cursorCreatedAt}
         ORDER BY created_at DESC
         LIMIT ${limit}
      `) as Record<string, unknown>[])
    : ((await sql`
        SELECT * FROM flow_ledger
         WHERE company_id = ${companyId}
         ORDER BY created_at DESC
         LIMIT ${limit}
      `) as Record<string, unknown>[]);
  return rows.map(mapLedger);
}

export async function listActiveBundles(): Promise<FlowBundle[]> {
  const rows = (await sql`
    SELECT id, name, flows, price_cents, is_active, display_order
      FROM flow_bundles
     WHERE is_active = true
     ORDER BY display_order
  `) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id:           r.id as string,
    name:         r.name as string,
    flows:        r.flows as number,
    priceCents:   r.price_cents as number,
    isActive:     r.is_active as boolean,
    displayOrder: r.display_order as number,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Mutations (purchases: flowPurchaseService.ts)
// ─────────────────────────────────────────────────────────────────────────────

export {
  startBundlePurchase, completeBundlePurchase, completePaidBundlePurchase, failBundlePurchase, purchaseBundle, getPurchaseStatus,
} from './flowPurchaseService';
export type { PurchaseResult, PendingPurchase, PurchaseStatus, PaidAmount, PurchaseStatusResult } from './flowPurchaseService';


export { deductFlows, refundFlows, adminAdjust } from './flowWalletMutations';


export interface AutoTopupResult {
  success: boolean;
  reason?: 'disabled' | 'no_payment_method' | 'no_bundle';
  purchaseId?: string;
  balanceAfter?: number;
}

/**
 * Fire auto top-up for a company that has hit a zero balance.
 * v1 has no payment gateway, so it never credits: with auto top-up on and a
 * bundle chosen it answers `no_payment_method` and the tenant tops up
 * manually. A stored token is deliberately not consulted: nothing here could
 * charge it, and crediting Flows on its mere presence was a free-Flows path.
 * v2 will call the gateway (spec §10 lists it as out of scope for v1).
 */
export async function triggerAutoTopup(companyId: string): Promise<AutoTopupResult> {
  const wallet = await getWallet(companyId);
  if (!wallet || !wallet.autoTopupEnabled) {
    return { success: false, reason: 'disabled' };
  }
  if (!wallet.autoTopupBundleId) {
    return { success: false, reason: 'no_bundle' };
  }
  return { success: false, reason: 'no_payment_method' };
}

export async function setAutoTopup(
  companyId: string,
  enabled: boolean,
  bundleId: string | null,
): Promise<void> {
  await migrationAdminSqlTx('flow_set_auto_topup', async (tx) => {
    await ensureWalletRow(tx, companyId);
    await tx`
      UPDATE flow_wallet
         SET auto_topup_enabled   = ${enabled},
             auto_topup_bundle_id = ${bundleId}
       WHERE company_id = ${companyId}
    `;
  });
}

export async function recalculateNudge(companyId: string): Promise<NudgeLevel> {
  const wallet = await getWallet(companyId);
  if (!wallet) return 'none';
  const next = computeNudge(wallet.monthFlowsUsed);
  if (next !== wallet.nudgeLevel) {
    await migrationAdminSqlTx('flow_recalculate_nudge', (tx) => tx`
      UPDATE flow_wallet SET nudge_level = ${next} WHERE company_id = ${companyId}
    `);
  }
  return next;
}

export async function resetMonthlyCounter(): Promise<{ companiesReset: number }> {
  const rows = (await migrationAdminSqlTx('flow_reset_month', (tx) => tx`
    UPDATE flow_wallet
       SET month_flows_used = 0,
           month_reset_at   = now(),
           nudge_level      = 'none'
    RETURNING company_id
  `)) as Array<{ company_id: string }>;
  return { companiesReset: rows.length };
}

// Exposed for unit tests — the nudge function is pure and worth asserting directly.
export const __test = { computeNudge };
