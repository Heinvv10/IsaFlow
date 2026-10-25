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
 * Its own migration_admin transaction; the credit is another
 * (`completeBundlePurchase` / `completePaidBundlePurchase`).
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

/** What the gateway says was paid (`amountCents` null when it reported no usable amount). */
export interface PaidAmount { companyId: string; amountCents: number | null; currency?: string }

/**
 * Idempotently credit the wallet for a previously-started purchase, with no
 * payment check: only the dev-only unpaid fallback (purchase.ts) calls it.
 * Re-invocations on an already-succeeded row are a no-op and return the
 * current balance. The persisted `flow_purchases.flows` is the source of
 * truth, so the credit is at the originally-quoted amount.
 */
export async function completeBundlePurchase(
  purchaseId: string,
  companyId: string,
): Promise<PurchaseResult> {
  return (await creditPurchase(purchaseId, null, companyId))!;
}

/**
 * The webhook's completion: credits only when the purchase belongs to the
 * payment request's company and at least its price was paid, in rand. The
 * payment request is app-written, so its purchase link is a claim the webhook
 * also checks against Paystack's metadata (S-07e). Null when refused, logged
 * here at error level; the caller marks the request for review (a throw would
 * make every redelivery repeat it).
 */
export async function completePaidBundlePurchase(purchaseId: string, paid: PaidAmount): Promise<PurchaseResult | null> {
  return creditPurchase(purchaseId, paid, paid.companyId);
}

// On a role that bypasses row security, so the purchase is always looked up within the company it is for.
async function creditPurchase(purchaseId: string, paid: PaidAmount | null, companyId: string): Promise<PurchaseResult | null> {
  return migrationAdminSqlTx('flow_complete_purchase', async (tx) => {
    const rows = (await tx`
      SELECT id, company_id, bundle_id, flows, price_cents, status
        FROM flow_purchases
       WHERE id = ${purchaseId}
         AND company_id = ${companyId}
       FOR NO KEY UPDATE
    `) as Array<{
      id: string; company_id: string; bundle_id: string;
      flows: number; price_cents: number; status: PurchaseStatus;
    }>;
    const row = rows[0];
    if (!row && paid) {
      log.error('flow purchase not credited: not this company\'s', { purchaseId, companyId }, 'BILLING');
      return null;
    }
    if (!row) throw new Error(`flow_purchases ${purchaseId} not found`);
    // At least the price, in rand: paying more buys nothing extra, and a payment
    // in no stated currency is not a ZAR payment.
    if (paid && (row.company_id !== paid.companyId || paid.amountCents === null
        || Number(paid.amountCents) < Number(row.price_cents) || paid.currency !== 'ZAR')) {
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
      // From the webhook a throw would make every redelivery repeat it (500s
      // for ever, the payment still taken): refuse it once, logged for review.
      if (paid) {
        log.error('flow purchase not credited: it had already failed', { purchaseId, companyId: row.company_id }, 'BILLING');
        return null;
      }
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
  companyId: string,
  reason?: string,
): Promise<void> {
  const rows = (await migrationAdminSqlTx('flow_fail_purchase', (tx) => tx`
    UPDATE flow_purchases
       SET status = 'failed'
     WHERE id = ${purchaseId}
       AND company_id = ${companyId}
       AND status = 'pending'
     RETURNING id
  `)) as Array<{ id: string }>;
  if (rows[0]) {
    log.info('flow purchase marked failed', { purchaseId, reason }, 'BILLING');
  }
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
