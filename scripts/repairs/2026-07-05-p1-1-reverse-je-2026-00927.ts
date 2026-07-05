/**
 * P1.1 data repair (A–Z programme, audit C1/C2 family): reverse Demo journal
 * JE-2026-00927 — the approval journal of cancelled invoice INV0000004 that
 * the pre-fix cancel path left posted (R1,725 AR/Revenue/VAT overstatement
 * in the Demo company's books; deliberate audit evidence, 2026-07-04).
 *
 * Usage:
 *   bun scripts/repairs/2026-07-05-p1-1-reverse-je-2026-00927.ts            # dry run
 *   bun scripts/repairs/2026-07-05-p1-1-reverse-je-2026-00927.ts --execute  # apply
 *
 * Target env comes from DATABASE_URL. The entry exists in PROD Demo only
 * (dev Demo has no JE-2026-00927 — verified 2026-07-05).
 *
 * Safety: single dedicated pg.Client so BEGIN/COMMIT are genuinely one
 * transaction; PK-scoped; old-state guarded (posted + unreversed + exact
 * totals); count-asserted. Rollback: the script prints the created reversal
 * id — DELETE its lines+entry and reset the original's status/reversed_*
 * fields to undo.
 *
 * Scope note: Demo-company repair is explicitly in-scope per the goal's P1.1.
 * The equivalent Britech repair (JE-2026-00507) is HUMAN-GATED — separate
 * proposal, not this script.
 */

import { randomUUID } from 'node:crypto';
import pg from 'pg';

const DEMO_COMPANY = '00000000-0000-0000-0000-000000000001';
const ENTRY_NUMBER = 'JE-2026-00927';
const EXPECTED_TOTAL_DEBIT = 1725.0;
const DEMO_ADMIN_USER = 'd8a83148-cca6-4951-b13a-66322e4d5dbc'; // admin@isaflow.co.za

const execute = process.argv.includes('--execute');

type Row = Record<string, unknown>;

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const client = new pg.Client({
    connectionString: url,
    ssl: url.includes('sslmode=disable') ? false : { rejectUnauthorized: false },
  });
  await client.connect();

  try {
    const entries = (
      await client.query(
        `SELECT id, status, entry_date, fiscal_period_id, description, source
         FROM gl_journal_entries
         WHERE company_id = $1::UUID AND entry_number = $2`,
        [DEMO_COMPANY, ENTRY_NUMBER],
      )
    ).rows as Row[];
    if (entries.length !== 1) {
      throw new Error(`Expected exactly 1 ${ENTRY_NUMBER} in Demo, found ${entries.length}`);
    }
    const entry = entries[0]!;
    const entryId = String(entry.id);
    console.log(
      `Found ${ENTRY_NUMBER}: id=${entryId} status=${entry.status} desc="${entry.description}"`,
    );

    if (String(entry.status) !== 'posted') {
      throw new Error(
        `Refusing: entry status is '${entry.status}', expected 'posted' (already repaired?)`,
      );
    }

    const lines = (
      await client.query(
        `SELECT gl_account_id, debit, credit, description
         FROM gl_journal_lines
         WHERE journal_entry_id = $1::UUID AND company_id = $2::UUID
         ORDER BY created_at`,
        [entryId, DEMO_COMPANY],
      )
    ).rows as Row[];
    const totalDebit = lines.reduce((t, l) => t + Number(l.debit), 0);
    const totalCredit = lines.reduce((t, l) => t + Number(l.credit), 0);
    console.log(
      `Lines: ${lines.length}, ΣDr=${totalDebit.toFixed(2)} ΣCr=${totalCredit.toFixed(2)}`,
    );
    if (
      Math.abs(totalDebit - EXPECTED_TOTAL_DEBIT) > 0.005 ||
      Math.abs(totalDebit - totalCredit) > 0.005
    ) {
      throw new Error(
        `Refusing: totals don't match expected R${EXPECTED_TOTAL_DEBIT.toFixed(2)} balanced entry`,
      );
    }

    const already = (
      await client.query(
        `SELECT id FROM gl_journal_entries
         WHERE company_id = $1::UUID AND reversal_of_id = $2::UUID`,
        [DEMO_COMPANY, entryId],
      )
    ).rows as Row[];
    if (already.length > 0) {
      throw new Error(`Refusing: reversal already exists (${already[0]!.id})`);
    }

    if (!execute) {
      console.log('\nDRY RUN — would post a reversing entry (Dr↔Cr swapped), mark the');
      console.log(`original 'reversed', and link reversal_of_id. Re-run with --execute.`);
      return;
    }

    const reversalId = randomUUID();
    const todayStr = new Date().toISOString().slice(0, 10);
    await client.query('BEGIN');
    try {
      // Period for the reversal = the period containing ITS entry date (P2.2
      // invariant: fiscal_period must match entry_date).
      const period = (
        await client.query(
          `SELECT id FROM fiscal_periods
           WHERE company_id = $1::UUID AND start_date <= $2::DATE AND end_date >= $2::DATE
           LIMIT 1`,
          [DEMO_COMPANY, todayStr],
        )
      ).rows as Row[];
      const periodId = period.length > 0 ? String(period[0]!.id) : null;

      await client.query(
        `INSERT INTO gl_journal_entries (
           id, company_id, entry_date, fiscal_period_id, description, source,
           created_by, posting_agent, status, posted_by, posted_at, reversal_of_id
         ) VALUES ($1::UUID, $2::UUID, $3::DATE, $4, $5, $6, $7::UUID, $8, 'posted', $7::UUID, NOW(), $9::UUID)`,
        [
          reversalId,
          DEMO_COMPANY,
          todayStr,
          periodId,
          `Reversal of ${ENTRY_NUMBER} (P1.1 repair: cancel-without-reversal, audit C1)`,
          String(entry.source),
          DEMO_ADMIN_USER,
          `human:${DEMO_ADMIN_USER}`,
          entryId,
        ],
      );
      for (const l of lines) {
        await client.query(
          `INSERT INTO gl_journal_lines (
             journal_entry_id, gl_account_id, debit, credit, description, company_id
           ) VALUES ($1::UUID, $2::UUID, $3, $4, $5, $6::UUID)`,
          [
            reversalId,
            String(l.gl_account_id),
            Number(l.credit),
            Number(l.debit),
            `Reversal: ${String(l.description ?? '')}`,
            DEMO_COMPANY,
          ],
        );
      }
      const updated = await client.query(
        `UPDATE gl_journal_entries
         SET status = 'reversed', reversed_by = $1::UUID, reversed_at = NOW()
         WHERE id = $2::UUID AND company_id = $3::UUID AND status = 'posted'
         RETURNING id`,
        [DEMO_ADMIN_USER, entryId, DEMO_COMPANY],
      );
      if (updated.rowCount !== 1) {
        throw new Error(`Original UPDATE matched ${updated.rowCount} rows, expected 1`);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }

    console.log(`\nDONE. Reversal entry id=${reversalId} posted, ${ENTRY_NUMBER} marked reversed.`);
    console.log('Verify: bun scripts/integrity-check.ts (reversal-pairs check must stay PASS).');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('REPAIR FAILED:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
