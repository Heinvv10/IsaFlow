/**
 * The flow_wallet / flow_ledger statements every Flows mutation shares, run
 * inside a migration_admin transaction (S-07e, migration 945): no app role may
 * write these tables. Shared by flowWalletService.ts and flowPurchaseService.ts.
 */
import type { TxSql } from '@/lib/neon';
export type LedgerType = 'purchase' | 'debit' | 'refund' | 'admin_adjustment';
export type NudgeLevel = 'none' | 'yellow' | 'orange' | 'red';


export async function ensureWalletRow(tx: TxSql, companyId: string): Promise<void> {
  await tx`
    INSERT INTO flow_wallet (company_id, month_reset_at)
    VALUES (${companyId}, now())
    ON CONFLICT (company_id) DO NOTHING
  `;
}

export async function lockWallet(
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

export async function writeLedger(
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

export function computeNudge(monthFlowsUsed: number): NudgeLevel {
  for (const t of NUDGE_THRESHOLDS) {
    if (monthFlowsUsed >= t.min) return t.level;
  }
  return 'none';
}
