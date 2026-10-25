/**
 * Flow bundle purchases: start (a pending row), completion (the credit) and
 * failure. Every write runs in a migration_admin transaction (S-07e, migration
 * 945). A purchase completed from a Paystack payment is credited only when the
 * payment matches it (`completePaidBundlePurchase`). Re-exported by
 * flowWalletService.ts.
 */
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { migrationAdminSqlTx } from '@/lib/auth/migrationAdminPool';
import { ensureWalletRow, lockWallet, writeLedger } from './flowWalletTx';

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
  return migrationAdminSqlTx('flow_start_purchase', async (tx) => {
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
/** What the gateway says was paid, for the purchase a payment request names. */
export interface PaidAmount { companyId: string; amountCents: number; currency?: string }

export async function completeBundlePurchase(
  purchaseId: string,
): Promise<PurchaseResult> {
  return (await creditPurchase(purchaseId, null))!;
}

/**
 * The webhook's completion: credits only when the purchase belongs to the
 * payment request's company and its price is what Paystack received. The
 * payment request is app-writable, so its purchase link is a claim, not a fact
 * (S-07e): a cheap payment pointed at a large purchase credits nothing. Null
 * when refused; the caller logs it (a throw would make every redelivery repeat it).
 */
export async function completePaidBundlePurchase(purchaseId: string, paid: PaidAmount): Promise<PurchaseResult | null> {
  return creditPurchase(purchaseId, paid);
}

async function creditPurchase(purchaseId: string, paid: PaidAmount | null): Promise<PurchaseResult | null> {
  return migrationAdminSqlTx('flow_complete_purchase', async (tx) => {
    const rows = (await tx`
      SELECT id, company_id, bundle_id, flows, price_cents, status
        FROM flow_purchases
       WHERE id = ${purchaseId}
       FOR UPDATE
    `) as Array<{
      id: string; company_id: string; bundle_id: string;
      flows: number; price_cents: number; status: PurchaseStatus;
    }>;
    const row = rows[0];
    if (!row) throw new Error(`flow_purchases ${purchaseId} not found`);
    if (paid && (row.company_id !== paid.companyId || Number(row.price_cents) !== Number(paid.amountCents)
        || paid.currency !== 'ZAR')) { // a payment in no stated currency is not a ZAR payment
      log.error('flow purchase not credited: the payment does not match it', {
        purchaseId, purchaseCompanyId: row.company_id, paidCompanyId: paid.companyId,
        priceCents: row.price_cents, paidCents: paid.amountCents, currency: paid.currency,
      }, 'BILLING');
      return null;
    }

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
  companyId?: string,
): Promise<void> {
  const rows = (await migrationAdminSqlTx('flow_fail_purchase', (tx) => tx`
    UPDATE flow_purchases
       SET status = 'failed'
     WHERE id = ${purchaseId}
       AND status = 'pending'
       AND (${companyId ?? null}::uuid IS NULL OR company_id = ${companyId ?? null}::uuid)
     RETURNING id
  `)) as Array<{ id: string }>;
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
