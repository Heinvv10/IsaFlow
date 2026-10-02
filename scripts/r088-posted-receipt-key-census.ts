/**
 * R-088: census of receipts posted BEFORE migration 710, which carry no
 * `posted_receipt_key` — and the backfill SQL for a person to review and run.
 *
 *   bun scripts/r088-posted-receipt-key-census.ts
 *   bun scripts/r088-posted-receipt-key-census.ts --company <uuid>
 *   bun scripts/r088-posted-receipt-key-census.ts --emit-sql /path/backfill.sql
 *
 * READ-ONLY. It opens a READ ONLY transaction and writes nothing to the
 * database. `--emit-sql` writes a file of UPDATE statements; nothing runs them.
 *
 * Why it exists: the receipt routes refuse a re-upload of an already-posted
 * receipt on the same bytes OR the same vendor|date|total|VAT key. The byte
 * match reads `raw_bytes_sha256`, which every intake path has always written,
 * so it covers old postings. The key match reads `posted_receipt_key`, which
 * only postings made after 710 carry — so a re-ENCODED copy (the same slip
 * forwarded by WhatsApp after it was emailed) of a receipt posted before 710
 * is not caught. Backfilling the key closes that gap for the receipts the
 * live code would have keyed: documents booked through a receipt path, i.e.
 * with an `auto_expense_receipt` journal or on an expense-claim line.
 *
 * The report also lists key groups with more than one posted document per
 * company: those are receipts ALREADY booked twice (or genuine same-day
 * repeats with no slip number read). The backfill does not touch them
 * differently — the key has no unique index — but a person should look.
 *
 * Run with a role that bypasses RLS (`postgres` / `migration_admin`); under
 * RLS the census silently sees only the rows the session's company can see.
 */
import { writeFileSync } from 'node:fs';
import { Pool } from 'pg';
import { receiptContentKey } from '../src/modules/accounting/services/capture/receiptFingerprint';
import { rollbackFailed } from '../src/lib/rollbackFailed';

interface Row {
  id: string;
  company_id: string;
  file_name: string;
  posted_at: Date;
  extracted_data: Record<string, unknown> | null;
  posted_receipt_key: string | null;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const quote = (s: string): string => `'${s.replace(/'/g, "''")}'`;

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const company = arg('--company') ?? null;
  const emit = arg('--emit-sql');

  const pool = new Pool({ connectionString: url });
  const client = await pool.connect();
  let rows: Row[];
  try {
    await client.query('BEGIN READ ONLY');
    rows = (await client.query<Row>(
      `SELECT cd.id, cd.company_id, cd.file_name, cd.posted_at, cd.extracted_data, cd.posted_receipt_key
         FROM captured_documents cd
        WHERE cd.posted_at IS NOT NULL
          AND ($1::uuid IS NULL OR cd.company_id = $1::uuid)
          AND (EXISTS (SELECT 1 FROM gl_journal_entries je
                        WHERE je.source_document_id = cd.id AND je.company_id = cd.company_id
                          AND je.source = 'auto_expense_receipt')
            OR EXISTS (SELECT 1 FROM expense_claim_lines ecl
                        WHERE ecl.source_document_id = cd.id AND ecl.company_id = cd.company_id))
        ORDER BY cd.company_id, cd.posted_at, cd.id`,
      [company],
    )).rows;
  } finally {
    // In the finally, so a failed SELECT is rolled back too (R-176).
    const unusable = await rollbackFailed(client, 'r088-posted-receipt-key-census');
    client.release(unusable); // R-176: a failed ROLLBACK leaves the transaction open; destroy it, do not pool it
    await pool.end();
  }

  const missing = rows.filter((r) => r.posted_receipt_key === null);
  const planned = missing
    .map((r) => ({ row: r, key: receiptContentKey(r.extracted_data ?? {}) }))
    .filter((p): p is { row: Row; key: string } => p.key !== null);

  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const key = r.posted_receipt_key ?? planned.find((p) => p.row.id === r.id)?.key ?? null;
    if (!key) continue;
    const g = `${r.company_id}|${key}`;
    groups.set(g, [...(groups.get(g) ?? []), r]);
  }
  const repeated = [...groups.entries()].filter(([, g]) => g.length > 1);

  const out = process.stdout;
  out.write(`posted receipt documents: ${rows.length}\n`);
  out.write(`  without posted_receipt_key: ${missing.length}\n`);
  out.write(`  of those, keyable (vendor, date and total read): ${planned.length}\n`);
  out.write(`key groups with more than one posted document: ${repeated.length}\n`);
  for (const [g, docs] of repeated) {
    out.write(`  ${g}\n`);
    for (const d of docs) out.write(`    ${d.id}  ${d.file_name}  posted ${d.posted_at.toISOString()}\n`);
  }

  if (emit) {
    const sql = [
      '-- R-088 posted_receipt_key backfill. Review before running; one UPDATE per document.',
      'BEGIN;',
      ...planned.map((p) => `UPDATE captured_documents SET posted_receipt_key = ${quote(p.key)}`
        + ` WHERE id = ${quote(p.row.id)} AND company_id = ${quote(p.row.company_id)}`
        + ' AND posted_at IS NOT NULL AND posted_receipt_key IS NULL;'),
      'COMMIT;',
      '',
    ].join('\n');
    writeFileSync(emit, sql);
    out.write(`wrote ${planned.length} UPDATE statement(s) to ${emit}\n`);
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
