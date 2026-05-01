/**
 * PAYG Flow Wallet service.
 *
 * Owns every mutation of `flow_wallet`, `flow_ledger`, and `flow_purchases`.
 * Each mutating call is atomic: the balance update and the ledger row are
 * written in the same transaction, so `flow_ledger` always has exactly one
 * row per balance change and `balance_after` on the most-recent ledger row
 * always equals `flow_wallet.balance_flows`.
 *
 * Spec: docs/superpowers/specs/2026-04-19-payg-flows-pricing-design.md §5
 */

import { sql, withTransaction, type TxSql } from '@/lib/neon';
import { log } from '@/lib/logger';

export type LedgerType = 'purchase' | 'debit' | 'refund' | 'admin_adjustment';
export type NudgeLevel = 'none' | 'yellow' | 'orange' | 'red';

export interface FlowWallet {
  companyId: string;
  balance: number;
  autoTopupEnabled: boolean;
  autoTopupBundleId: string | null;
  paymentMethodToken: string | null;
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

export class InsufficientFlowsError extends Error {
  constructor(
    public readonly balance: number,
    public readonly required: number,
  ) {
    super(`insufficient_flows: balance ${balance} < required ${required}`);
    this.name = 'InsufficientFlowsError';
  }
}

// Nudge thresholds from spec §6 (based on month_flows_used).
const NUDGE_THRESHOLDS: Array<{ level: NudgeLevel; min: number }> = [
  { level: 'red',    min: 2900 },
  { level: 'orange', min: 2400 },
  { level: 'yellow', min: 1800 },
  { level: 'none',   min: 0 },
];

function computeNudge(monthFlowsUsed: number): NudgeLevel {
  for (const t of NUDGE_THRESHOLDS) {
    if (monthFlowsUsed >= t.min) return t.level;
  }
  return 'none';
}

function mapWallet(row: Record<string, unknown>): FlowWallet {
  return {
    companyId:           row.company_id as string,
    balance:             row.balance_flows as number,
    autoTopupEnabled:    row.auto_topup_enabled as boolean,
    autoTopupBundleId:   (row.auto_topup_bundle_id as string | null) ?? null,
    paymentMethodToken:  (row.payment_method_token as string | null) ?? null,
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
  const rows = (await sql`
    SELECT * FROM flow_wallet WHERE company_id = ${companyId} LIMIT 1
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
// Internal helpers running inside a transaction
// ─────────────────────────────────────────────────────────────────────────────

async function ensureWalletRow(tx: TxSql, companyId: string): Promise<void> {
  await tx`
    INSERT INTO flow_wallet (company_id, month_reset_at)
    VALUES (${companyId}, now())
    ON CONFLICT (company_id) DO NOTHING
  `;
}

async function lockWallet(
  tx: TxSql,
  companyId: string,
): Promise<{ balance: number; monthFlowsUsed: number }> {
  const rows = (await tx`
    SELECT balance_flows, month_flows_used
      FROM flow_wallet
     WHERE company_id = ${companyId}
     FOR UPDATE
  `) as Array<{ balance_flows: number; month_flows_used: number }>;
  const r = rows[0];
  if (!r) {
    throw new Error(`flow_wallet missing after ensureWalletRow for ${companyId}`);
  }
  return { balance: r.balance_flows, monthFlowsUsed: r.month_flows_used };
}

async function writeLedger(
  tx: TxSql,
  params: {
    companyId: string;
    type: LedgerType;
    flows: number;          // signed
    balanceAfter: number;
    operationCode?: string | null;
    referenceId?: string | null;
    reason?: string | null;
  },
): Promise<void> {
  await tx`
    INSERT INTO flow_ledger (
      company_id, type, flows, balance_after, operation_code, reference_id, reason
    ) VALUES (
      ${params.companyId},
      ${params.type},
      ${params.flows},
      ${params.balanceAfter},
      ${params.operationCode ?? null},
      ${params.referenceId ?? null},
      ${params.reason ?? null}
    )
  `;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mutations
// ─────────────────────────────────────────────────────────────────────────────

export interface PurchaseResult {
  purchaseId: string;
  balanceAfter: number;
}

export interface PendingPurchase {
  purchaseId: string;
  bundle: { id: string; name: string; flows: number; priceCents: number };
}

export type PurchaseStatus = 'pending' | 'succeeded' | 'failed';

/**
 * Begin an asynchronous bundle purchase — records a `flow_purchases` row in
 * `status='pending'` without crediting the wallet.  Used by the Stitch
 * payment-link path: the caller then creates the Stitch link and redirects
 * the payer; the webhook calls `completeBundlePurchase` when paid.
 *
 * Callers wanting a synchronous credit (admin-recorded) should use
 * `purchaseBundle` which composes start + complete in one transaction.
 */
export async function startBundlePurchase(
  companyId: string,
  bundleId: string,
  opts: { paymentMethod?: string; autoTriggered?: boolean } = {},
): Promise<PendingPurchase> {
  return withTransaction(async (tx) => {
    const bundleRows = (await tx`
      SELECT id, name, flows, price_cents, is_active
        FROM flow_bundles
       WHERE id = ${bundleId}
    `) as Array<{ id: string; name: string; flows: number; price_cents: number; is_active: boolean }>;
    const bundle = bundleRows[0];
    if (!bundle || !bundle.is_active) {
      throw new Error(`bundle ${bundleId} not found or inactive`);
    }

    await ensureWalletRow(tx, companyId);

    const rows = (await tx`
      INSERT INTO flow_purchases (
        company_id, bundle_id, flows, price_cents, payment_method, status, auto_triggered
      ) VALUES (
        ${companyId}, ${bundle.id}, ${bundle.flows}, ${bundle.price_cents},
        ${opts.paymentMethod ?? 'paystack_transaction'}, 'pending', ${opts.autoTriggered ?? false}
      )
      RETURNING id
    `) as Array<{ id: string }>;

    return {
      purchaseId: rows[0]!.id,
      bundle: {
        id: bundle.id,
        name: bundle.name,
        flows: bundle.flows,
        priceCents: bundle.price_cents,
      },
    };
  });
}

/**
 * Idempotently credit the wallet for a previously-started purchase.  Safe to
 * call multiple times — re-invocations on an already-succeeded row are a
 * no-op and return the current wallet balance.  Called from the Stitch
 * webhook on payment.paid, and from `purchaseBundle` for the synchronous
 * admin-recorded path.
 *
 * Rejects pending → succeeded transitions on bundles that are no longer
 * active only if the bundle itself was soft-deleted between start and
 * complete; the persisted `flow_purchases.flows` amount is the source of
 * truth so the credit still happens at the originally-quoted amount.
 */
export async function completeBundlePurchase(
  purchaseId: string,
): Promise<PurchaseResult> {
  return withTransaction(async (tx) => {
    const rows = (await tx`
      SELECT id, company_id, bundle_id, flows, status
        FROM flow_purchases
       WHERE id = ${purchaseId}
       FOR UPDATE
    `) as Array<{
      id: string; company_id: string; bundle_id: string;
      flows: number; status: PurchaseStatus;
    }>;
    const row = rows[0];
    if (!row) throw new Error(`flow_purchases ${purchaseId} not found`);

    if (row.status === 'succeeded') {
      // Idempotent — read current balance and return without mutating.
      const [w] = (await tx`
        SELECT balance_flows FROM flow_wallet WHERE company_id = ${row.company_id}
      `) as Array<{ balance_flows: number }>;
      return { purchaseId: row.id, balanceAfter: w?.balance_flows ?? 0 };
    }
    if (row.status === 'failed') {
      throw new Error(`purchase ${purchaseId} already failed — cannot credit`);
    }

    await ensureWalletRow(tx, row.company_id);
    const { balance } = await lockWallet(tx, row.company_id);
    const newBalance = balance + row.flows;

    await tx`
      UPDATE flow_wallet
         SET balance_flows = ${newBalance}
       WHERE company_id = ${row.company_id}
    `;
    await tx`
      UPDATE flow_purchases SET status = 'succeeded' WHERE id = ${purchaseId}
    `;
    await writeLedger(tx, {
      companyId: row.company_id,
      type: 'purchase',
      flows: row.flows,
      balanceAfter: newBalance,
      operationCode: null,
      referenceId: purchaseId,
    });

    return { purchaseId, balanceAfter: newBalance };
  });
}

/**
 * Idempotently mark a pending purchase as failed.  No wallet mutation.
 * Used by the webhook on payment.failed / payment.cancelled / payment.expired.
 */
export async function failBundlePurchase(
  purchaseId: string,
  reason?: string,
): Promise<void> {
  const rows = (await sql`
    UPDATE flow_purchases
       SET status = 'failed'
     WHERE id = ${purchaseId}
       AND status = 'pending'
     RETURNING id
  `) as Array<{ id: string }>;
  if (rows[0]) {
    log.info('flow purchase marked failed', { purchaseId, reason }, 'BILLING');
  }
}

/**
 * Synchronous purchase (start + complete in one transaction) — admin-recorded
 * credits, auto-topup after a successful Stitch mandate charge, etc.
 */
export async function purchaseBundle(
  companyId: string,
  bundleId: string,
  opts: { paymentMethod?: string; autoTriggered?: boolean } = {},
): Promise<PurchaseResult> {
  const pending = await startBundlePurchase(companyId, bundleId, {
    paymentMethod: opts.paymentMethod ?? 'admin_recorded',
    autoTriggered: opts.autoTriggered ?? false,
  });
  return completeBundlePurchase(pending.purchaseId);
}

export interface PurchaseStatusResult {
  purchaseId: string;
  status: PurchaseStatus;
  flows: number;
  priceCents: number;
  paymentMethod: string;
}

export async function getPurchaseStatus(
  companyId: string,
  purchaseId: string,
): Promise<PurchaseStatusResult | null> {
  const rows = (await sql`
    SELECT id, status, flows, price_cents, payment_method
      FROM flow_purchases
     WHERE id = ${purchaseId}
       AND company_id = ${companyId}
     LIMIT 1
  `) as Array<{
    id: string; status: PurchaseStatus; flows: number;
    price_cents: number; payment_method: string;
  }>;
  const r = rows[0];
  return r ? {
    purchaseId: r.id,
    status: r.status,
    flows: r.flows,
    priceCents: r.price_cents,
    paymentMethod: r.payment_method,
  } : null;
}

export async function deductFlows(
  companyId: string,
  flowCost: number,
  operationCode: string,
  referenceId?: string | null,
): Promise<{ balanceAfter: number }> {
  if (flowCost <= 0 || !Number.isInteger(flowCost)) {
    throw new Error(`deductFlows: flowCost must be positive integer, got ${flowCost}`);
  }
  return withTransaction(async (tx) => {
    await ensureWalletRow(tx, companyId);
    const { balance, monthFlowsUsed } = await lockWallet(tx, companyId);

    if (balance < flowCost) {
      throw new InsufficientFlowsError(balance, flowCost);
    }

    const newBalance = balance - flowCost;
    const newMonthUsed = monthFlowsUsed + flowCost;
    const nudge = computeNudge(newMonthUsed);

    await tx`
      UPDATE flow_wallet
         SET balance_flows    = ${newBalance},
             month_flows_used = ${newMonthUsed},
             nudge_level      = ${nudge}
       WHERE company_id = ${companyId}
    `;

    await writeLedger(tx, {
      companyId,
      type: 'debit',
      flows: -flowCost,
      balanceAfter: newBalance,
      operationCode,
      referenceId: referenceId ?? null,
    });

    return { balanceAfter: newBalance };
  });
}

export async function refundFlows(
  companyId: string,
  flowCost: number,
  operationCode: string,
  referenceId?: string | null,
): Promise<{ balanceAfter: number }> {
  if (flowCost <= 0 || !Number.isInteger(flowCost)) {
    throw new Error(`refundFlows: flowCost must be positive integer, got ${flowCost}`);
  }
  return withTransaction(async (tx) => {
    await ensureWalletRow(tx, companyId);
    const { balance, monthFlowsUsed } = await lockWallet(tx, companyId);

    const newBalance = balance + flowCost;
    // Refund also unwinds month usage so the nudge doesn't punish refunded ops.
    const newMonthUsed = Math.max(0, monthFlowsUsed - flowCost);
    const nudge = computeNudge(newMonthUsed);

    await tx`
      UPDATE flow_wallet
         SET balance_flows    = ${newBalance},
             month_flows_used = ${newMonthUsed},
             nudge_level      = ${nudge}
       WHERE company_id = ${companyId}
    `;

    await writeLedger(tx, {
      companyId,
      type: 'refund',
      flows: flowCost,
      balanceAfter: newBalance,
      operationCode,
      referenceId: referenceId ?? null,
    });

    return { balanceAfter: newBalance };
  });
}

export async function adminAdjust(
  companyId: string,
  flows: number,
  reason: string,
): Promise<{ balanceAfter: number }> {
  if (flows === 0 || !Number.isInteger(flows)) {
    throw new Error(`adminAdjust: flows must be non-zero integer, got ${flows}`);
  }
  if (!reason || !reason.trim()) {
    throw new Error('adminAdjust: reason is required');
  }
  return withTransaction(async (tx) => {
    await ensureWalletRow(tx, companyId);
    const { balance } = await lockWallet(tx, companyId);

    const newBalance = balance + flows;
    if (newBalance < 0) {
      throw new InsufficientFlowsError(balance, Math.abs(flows));
    }

    await tx`
      UPDATE flow_wallet
         SET balance_flows = ${newBalance}
       WHERE company_id = ${companyId}
    `;

    await writeLedger(tx, {
      companyId,
      type: 'admin_adjustment',
      flows,
      balanceAfter: newBalance,
      reason,
    });

    return { balanceAfter: newBalance };
  });
}

export interface AutoTopupResult {
  success: boolean;
  reason?: 'disabled' | 'no_payment_method' | 'no_bundle' | 'gateway_unavailable';
  purchaseId?: string;
  balanceAfter?: number;
}

/**
 * Fire auto top-up for a company that has hit a zero balance.
 * v1: returns `no_payment_method` when the wallet has no stored token.
 * v2: will call the Stitch gateway once wired up; the spec §10 lists gateway
 * integration as out of scope for v1.
 */
export async function triggerAutoTopup(companyId: string): Promise<AutoTopupResult> {
  const wallet = await getWallet(companyId);
  if (!wallet || !wallet.autoTopupEnabled) {
    return { success: false, reason: 'disabled' };
  }
  if (!wallet.autoTopupBundleId) {
    return { success: false, reason: 'no_bundle' };
  }
  if (!wallet.paymentMethodToken) {
    // v1: no gateway — tenant must top-up manually.
    return { success: false, reason: 'no_payment_method' };
  }

  // v2 hook: charge via Stitch here.  Until then this path is unreachable in prod.
  try {
    const result = await purchaseBundle(companyId, wallet.autoTopupBundleId, {
      paymentMethod: 'auto_topup',
      autoTriggered: true,
    });
    return { success: true, purchaseId: result.purchaseId, balanceAfter: result.balanceAfter };
  } catch (err) {
    log.error(
      'auto-topup failed',
      err instanceof Error ? { message: err.message, companyId } : { err, companyId },
      'BILLING',
    );
    return { success: false, reason: 'gateway_unavailable' };
  }
}

export async function setAutoTopup(
  companyId: string,
  enabled: boolean,
  bundleId: string | null,
): Promise<void> {
  await withTransaction(async (tx) => {
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
    await sql`
      UPDATE flow_wallet SET nudge_level = ${next} WHERE company_id = ${companyId}
    `;
  }
  return next;
}

export async function resetMonthlyCounter(): Promise<{ companiesReset: number }> {
  const rows = (await sql`
    UPDATE flow_wallet
       SET month_flows_used = 0,
           month_reset_at   = now(),
           nudge_level      = 'none'
    RETURNING company_id
  `) as Array<{ company_id: string }>;
  return { companiesReset: rows.length };
}

// Exposed for unit tests — the nudge function is pure and worth asserting directly.
export const __test = { computeNudge };
