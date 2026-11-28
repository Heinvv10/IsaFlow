/**
 * A tenant owner upgrading their own trial company to a paid plan (behind the
 * dark flag `trial_self_serve_upgrade`, selfServeUpgradeGate.ts).
 *
 * The flow: the owner picks a plan, authorises a Paystack mandate
 * (startMandateCheckout, from POST /api/billing/upgrade/start), returns to the
 * upgrade return page, which verifies the mandate through the existing
 * POST /api/billing/paystack/mandate/verify, then calls convertOwnTrial
 * (POST /api/billing/upgrade/convert). Conversion happens on that authenticated
 * call, not in the webhook: no intent is stored, and an owner who closed the
 * tab after paying sees "Confirm upgrade" on the upgrade page instead.
 *
 * The conversion is trialConvertCore's, the same code the admin "Convert to
 * Paid" runs, with every self-serve option on: the company must have had a
 * trial, a chargeable Paystack mandate must be on file, and a retry on the same
 * plan is a no-op. App roles cannot write the billing tables or the company's
 * plan and status (S-07e migration 945, migration 936), so it runs on the
 * migration_admin pool in a transaction of its own (`self_serve_convert`), and
 * the tenant audit_log row is written in that same transaction: both commit or
 * neither. The company is only ever the verified request's.
 */

import { migrationAdminSqlTx } from '@/lib/auth/migrationAdminPool';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { logAuditOrThrow } from '@/modules/accounting/services/core/auditTrailService';
import { convertTrialInTx, type ConvertResult } from '@/modules/admin/services/trialConvertCore';

/** What audit_log.changes.metadata.change says for a self-serve conversion. */
export const SELF_SERVE_CONVERT_CHANGE = 'trial_self_serve_convert';

export interface ConvertOwnTrialInput {
  companyId: string;
  userId: string;
  userEmail?: string;
  planId: string;
  ip?: string;
  userAgent?: string;
}

export async function convertOwnTrial(input: ConvertOwnTrialInput): Promise<ConvertResult> {
  const { companyId, planId } = input;
  const result = await migrationAdminSqlTx('self_serve_convert', async (tx) => {
    const converted = await convertTrialInTx(tx, companyId, planId, {
      requireTrial: true, requireActiveMandate: true, samePlanIsNoop: true,
    });
    if (!converted.alreadyConverted) {
      await logAuditOrThrow({
        companyId,
        userId: input.userId,
        userEmail: input.userEmail,
        action: 'update',
        entityType: 'company',
        entityId: companyId,
        entityRef: 'subscription',
        changes: {
          fields: [{ field: 'subscription_status', old: 'trial', new: 'active', label: 'Subscription' }],
          metadata: {
            change: SELF_SERVE_CONVERT_CHANGE,
            planId,
            subscriptionId: converted.subscriptionId,
            firstChargeAt: converted.firstChargeAt,
          },
        },
        ip: input.ip,
        userAgent: input.userAgent,
      }, tx);
    }
    return converted;
  });
  log.info('Self-serve trial conversion', { companyId, planId, ...result }, 'selfServeUpgrade');
  return result;
}

export interface UpgradeState {
  /** Had a trial and does not pay yet (expired trials included). */
  onTrial: boolean;
  trialEndsAt: string | null;
  isPaid: boolean;
  currentPlanId: string | null;
  /** An active Paystack mandate with an authorization code: convert can run now. */
  hasChargeableMandate: boolean;
  /** Any active mandate: a new checkout is refused until it is revoked. */
  hasActiveMandate: boolean;
}

function isoOrNull(v: unknown): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

/** The company's upgrade state, read on the migration_admin pool (it reads the mandate's code column), scoped to the company. */
export async function getUpgradeState(companyId: string): Promise<UpgradeState> {
  return migrationAdminSqlTx('self_serve_upgrade_state', async (tx) => {
    const row = (await tx`
      SELECT c.trial_ends_at,
             COALESCE(c.status, 'active') AS status,
             cs.plan_id,
             COALESCE(cs.is_paid, false) AS is_paid,
             EXISTS (SELECT 1 FROM subscription_mandates m
                      WHERE m.company_id = c.id AND m.gateway = 'paystack' AND m.status = 'active') AS has_active_mandate,
             EXISTS (SELECT 1 FROM subscription_mandates m
                      WHERE m.company_id = c.id AND m.gateway = 'paystack' AND m.status = 'active'
                        AND m.paystack_authorization_code IS NOT NULL) AS has_chargeable_mandate
      FROM companies c
      LEFT JOIN LATERAL (
        SELECT s.plan_id, (s.status IN ('active', 'past_due') AND p.code <> 'trial') AS is_paid
        FROM subscriptions s JOIN plans p ON p.id = s.plan_id
        WHERE s.company_id = c.id AND s.status IN ('trial', 'active', 'past_due', 'paused')
        ORDER BY (s.status IN ('active', 'past_due') AND p.code <> 'trial') DESC, s.created_at DESC
        LIMIT 1
      ) cs ON true
      WHERE c.id = ${companyId}::uuid AND c.status IS DISTINCT FROM 'deleted'
    `)[0] as DbRow | undefined;
    if (!row) {
      return { onTrial: false, trialEndsAt: null, isPaid: false, currentPlanId: null, hasChargeableMandate: false, hasActiveMandate: false };
    }
    const isPaid = row.is_paid === true;
    const convertibleStatus = row.status === 'trial' || row.status === 'active';
    return {
      onTrial: row.trial_ends_at != null && !isPaid && convertibleStatus,
      trialEndsAt: isoOrNull(row.trial_ends_at),
      isPaid,
      currentPlanId: row.plan_id == null ? null : String(row.plan_id),
      hasChargeableMandate: row.has_chargeable_mandate === true,
      hasActiveMandate: row.has_active_mandate === true,
    };
  });
}
