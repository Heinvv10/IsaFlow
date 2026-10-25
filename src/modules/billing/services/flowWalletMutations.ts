/**
 * Flows debits and refunds (metering) and the admin site's adjustment. Debit
 * and refund run in their own migration_admin transaction (S-07e, migration
 * 945) and COMMIT on their own; adminAdjust runs on the platform_admin
 * request's transaction. Re-exported by flowWalletService.ts.
 */
import { withTransaction } from '@/lib/neon';
import { migrationAdminSqlTx } from '@/lib/auth/migrationAdminPool';
import { computeNudge, ensureWalletRow, InsufficientFlowsError, lockWallet, writeLedger } from './flowWalletTx';

export async function deductFlows(
  companyId: string,
  flowCost: number,
  operationCode: string,
  referenceId?: string | null,
): Promise<{ balanceAfter: number }> {
  if (flowCost <= 0 || !Number.isInteger(flowCost)) {
    throw new Error(`deductFlows: flowCost must be positive integer, got ${flowCost}`);
  }
  return migrationAdminSqlTx('flow_deduct', async (tx) => {
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
  return migrationAdminSqlTx('flow_refund', async (tx) => {
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
