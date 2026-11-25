/**
 * trial_lifecycle_emails markers (migration 1040): the claim that keeps each (company, stage) to one
 * send. Every statement carries its company_id; callers run them in a company-context transaction.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import type { TrialStage } from './stages';

export type FinalOutcome = 'sent' | 'unknown' | 'released';

/**
 * Claims the stage. True when this run owns it: a new row, or a 'released' one (every earlier send
 * provably did not leave) re-armed. False when any other row already holds it.
 */
export async function claimStage(
  companyId: string, stage: TrialStage, outcome: 'pending' | 'skipped_setup_complete' = 'pending',
): Promise<boolean> {
  const rows = (await sql`
    INSERT INTO trial_lifecycle_emails (company_id, stage, outcome)
    VALUES (${companyId}::UUID, ${stage}, ${outcome})
    ON CONFLICT (company_id, stage) DO UPDATE
      SET outcome = EXCLUDED.outcome, recipient_count = 0, sent_at = NULL, created_at = NOW()
      WHERE trial_lifecycle_emails.outcome = 'released'
    RETURNING id
  `) as DbRow[];
  return rows.length > 0;
}

/** Records how the claimed stage ended. 'released' lets the next run claim it again. */
export async function finaliseStage(
  companyId: string, stage: TrialStage, outcome: FinalOutcome, recipientCount: number,
): Promise<void> {
  await sql`
    UPDATE trial_lifecycle_emails
       SET outcome = ${outcome}, recipient_count = ${recipientCount},
           sent_at = CASE WHEN ${outcome}::TEXT = 'released' THEN NULL ELSE NOW() END
     WHERE company_id = ${companyId}::UUID AND stage = ${stage} AND outcome = 'pending'
  `;
}
