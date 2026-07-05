/**
 * Data correction: reverse orphaned GL journals on already-cancelled invoices.
 *
 * Before the C1 fix, cancelling an approved customer invoice only flipped
 * status='cancelled' and left the approval journal (DR Trade Debtors /
 * CR Revenue / CR VAT Output) posted forever, permanently overstating AR,
 * Revenue and VAT Output. This script heals invoices cancelled BEFORE the fix:
 * it finds customer invoices with status='cancelled' whose linked journal entry
 * is still status='posted', and reverses each journal (creating a "Reversal
 * of ..." entry — the gl_account_balances cache is maintained by the
 * migration-499 trigger). The invoices are already status='cancelled', so no
 * invoice-row update is needed: customer_invoices.balance is a GENERATED column
 * (total_amount - amount_paid) and outstanding-AR reporting already excludes
 * cancelled invoices by status.
 *
 * SAFE BY DEFAULT: dry-run unless --apply is passed. Idempotent — once a
 * journal is reversed it no longer matches (je.status becomes 'reversed').
 *
 * Linkage: the authoritative invoice->journal link is
 * customer_invoices.gl_journal_entry_id (postCustomerInvoiceToGL persists it on
 * approve). gl_journal_entries.source_document_id is NULL in prod and FK-bound to
 * captured_documents, so it is NEVER used here. As a REPORT-ONLY fallback, the
 * script also lists cancelled invoices whose gl_journal_entry_id is NULL but that
 * have a description-matched posted auto_invoice journal — these are surfaced for
 * manual review and are NEVER auto-reversed (the match is a heuristic, not the FK).
 *
 * Usage (operator, against prod):
 *   # Dry-run — prints what WOULD be reversed, mutates nothing:
 *   bunx tsx scripts/fixes/reverse-cancelled-invoice-journals.ts
 *
 *   # Apply — reverses journals and zeroes balances:
 *   bunx tsx scripts/fixes/reverse-cancelled-invoice-journals.ts --apply
 *
 *   # Optional: restrict to one tenant / stamp a specific reversed_by user:
 *   bunx tsx scripts/fixes/reverse-cancelled-invoice-journals.ts --apply --company <uuid> --user <uuid>
 *
 * Prefer MIGRATION_ADMIN_DATABASE_URL (a BYPASSRLS role) so RLS does not hide
 * rows; falls back to DATABASE_URL. Reversals post into the ORIGINAL entry's
 * fiscal period — if that period is closed the reversal is refused and reported,
 * not silently skipped.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Env loading (mirror scripts/backfill-auto-postings.ts) — must run before the
// @/lib/neon pool is first used so it connects to the right database/role.
// ---------------------------------------------------------------------------
const envPath = path.resolve(__dirname, '..', '..', '.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, k, rawV] = m;
    if (!process.env[k!]) process.env[k!] = rawV!.replace(/^["']|["']$/g, '');
  }
}

// Prefer a BYPASSRLS admin role so cancelled invoices aren't hidden by RLS.
// @/lib/neon's pool reads process.env.DATABASE_URL lazily on first query, so
// overriding it here (before any query) is sufficient.
if (process.env.MIGRATION_ADMIN_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.MIGRATION_ADMIN_DATABASE_URL;
} else if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL (or MIGRATION_ADMIN_DATABASE_URL) is not set. Create .env.local or export it.');
  process.exit(1);
}

// Imported after env is wired up. reverseJournalEntry runs on the same
// @/lib/neon pool, so both share one connection pool / database.
import { sql } from '@/lib/neon';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';

type Row = Record<string, unknown>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const getArg = (flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const apply = args.includes('--apply');
const companyFilter = getArg('--company');
const userOverride = getArg('--user');

if (companyFilter && !UUID_PATTERN.test(companyFilter)) {
  console.error(`--company must be a UUID, got: ${companyFilter}`);
  process.exit(1);
}
if (userOverride && !UUID_PATTERN.test(userOverride)) {
  console.error(`--user must be a UUID, got: ${userOverride}`);
  process.exit(1);
}

console.log(
  `\nReverse cancelled-invoice journals — mode=${apply ? 'APPLY (mutating)' : 'DRY-RUN'}` +
    `${companyFilter ? ` company=${companyFilter}` : ' (all companies)'}\n`,
);

// ---------------------------------------------------------------------------
// Query: cancelled invoices whose linked journal is still posted
// ---------------------------------------------------------------------------
async function findOrphanedJournals(): Promise<Row[]> {
  if (companyFilter) {
    return (await sql`
      SELECT ci.id AS invoice_id, ci.company_id, ci.invoice_number,
             ci.total_amount, ci.balance, ci.gl_journal_entry_id,
             je.entry_number, je.status AS je_status
      FROM customer_invoices ci
      JOIN gl_journal_entries je
        ON je.id = ci.gl_journal_entry_id AND je.company_id = ci.company_id
      WHERE ci.status = 'cancelled' AND je.status = 'posted'
        AND ci.company_id = ${companyFilter}::UUID
      ORDER BY ci.company_id, ci.invoice_number
    `) as Row[];
  }
  return (await sql`
    SELECT ci.id AS invoice_id, ci.company_id, ci.invoice_number,
           ci.total_amount, ci.balance, ci.gl_journal_entry_id,
           je.entry_number, je.status AS je_status
    FROM customer_invoices ci
    JOIN gl_journal_entries je
      ON je.id = ci.gl_journal_entry_id AND je.company_id = ci.company_id
    WHERE ci.status = 'cancelled' AND je.status = 'posted'
    ORDER BY ci.company_id, ci.invoice_number
  `) as Row[];
}

/**
 * Fallback: cancelled invoices with gl_journal_entry_id IS NULL that still have
 * a candidate posted 'auto_invoice' journal, matched by the exact description
 * postCustomerInvoiceToGL writes ("Customer invoice <number>"). This catches
 * legacy rows where the approve-time link-back never persisted (e.g. the
 * nested-transaction path). These are REPORT-ONLY — the description match is a
 * heuristic, not the authoritative FK link, so the operator must verify each
 * before reversing manually. Reversal entries are excluded because their
 * description is "Reversal of JE-...".
 */
async function findNullLinkOrphanCandidates(): Promise<Row[]> {
  if (companyFilter) {
    return (await sql`
      SELECT ci.id AS invoice_id, ci.company_id, ci.invoice_number, ci.total_amount,
             je.id AS je_id, je.entry_number, je.status AS je_status
      FROM customer_invoices ci
      JOIN gl_journal_entries je
        ON je.company_id = ci.company_id
       AND je.source = 'auto_invoice'
       AND je.status = 'posted'
       AND je.description = ('Customer invoice ' || ci.invoice_number)
      WHERE ci.status = 'cancelled' AND ci.gl_journal_entry_id IS NULL
        AND ci.company_id = ${companyFilter}::UUID
      ORDER BY ci.company_id, ci.invoice_number
    `) as Row[];
  }
  return (await sql`
    SELECT ci.id AS invoice_id, ci.company_id, ci.invoice_number, ci.total_amount,
           je.id AS je_id, je.entry_number, je.status AS je_status
    FROM customer_invoices ci
    JOIN gl_journal_entries je
      ON je.company_id = ci.company_id
     AND je.source = 'auto_invoice'
     AND je.status = 'posted'
     AND je.description = ('Customer invoice ' || ci.invoice_number)
    WHERE ci.status = 'cancelled' AND ci.gl_journal_entry_id IS NULL
    ORDER BY ci.company_id, ci.invoice_number
  `) as Row[];
}

/** Resolve the reversed_by user id: --user override, else the first users row. */
async function resolveReversingUser(): Promise<string> {
  if (userOverride) return userOverride;
  const rows = (await sql`SELECT id FROM users ORDER BY created_at LIMIT 1`) as Row[];
  if (rows.length === 0) {
    throw new Error('No users found to attribute the reversal to. Pass --user <uuid>.');
  }
  return String(rows[0]!.id);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
(async () => {
  try {
    const rows = await findOrphanedJournals();
    const candidates = await findNullLinkOrphanCandidates();

    if (rows.length === 0 && candidates.length === 0) {
      console.log('No cancelled invoices with still-posted journals found. Nothing to do.');
      process.exit(0);
    }

    // Group + summarise per company (loud, per the operator brief).
    const byCompany = new Map<string, Row[]>();
    for (const r of rows) {
      const cid = String(r.company_id);
      const list = byCompany.get(cid) ?? [];
      list.push(r);
      byCompany.set(cid, list);
    }

    console.log(`[Linked] ${rows.length} orphaned journal(s) across ${byCompany.size} company(ies) — reversible:\n`);
    for (const [cid, list] of byCompany) {
      const total = list.reduce((s, r) => s + Number(r.total_amount ?? 0), 0);
      console.log(`  Company ${cid} — ${list.length} invoice(s), overstated by R${total.toFixed(2)}:`);
      for (const r of list) {
        console.log(
          `    ${String(r.invoice_number)}  JE ${String(r.entry_number)}  ` +
            `R${Number(r.total_amount ?? 0).toFixed(2)}  (balance=R${Number(r.balance ?? 0).toFixed(2)})`,
        );
      }
    }

    // Report-only fallback: NULL-link cancelled invoices with a description-matched
    // posted journal. NEVER auto-reversed — the operator must verify and act.
    if (candidates.length > 0) {
      console.log(
        `\n[NULL-link candidates] ${candidates.length} cancelled invoice(s) have NO gl_journal_entry_id ` +
          'but a description-matched posted auto_invoice journal. REVIEW MANUALLY — NOT auto-reversed:',
      );
      for (const c of candidates) {
        console.log(
          `    company ${String(c.company_id)}  ${String(c.invoice_number)}  ` +
            `candidate JE ${String(c.entry_number)} (${String(c.je_id)})  R${Number(c.total_amount ?? 0).toFixed(2)}`,
        );
      }
      console.log(
        '    -> These are matched by description, not the FK link. Confirm each is the correct journal, then\n' +
          '       either backfill customer_invoices.gl_journal_entry_id and re-run, or reverse manually.',
      );
    }

    if (!apply) {
      console.log(
        `\nDRY-RUN — nothing was changed. Re-run with --apply to reverse the ${rows.length} linked journal(s)` +
          `${candidates.length > 0 ? ' (NULL-link candidates are never auto-reversed)' : ''}.`,
      );
      process.exit(0);
    }

    if (rows.length === 0) {
      console.log('\nNo linked journals to reverse. NULL-link candidates (if any) require manual review.');
      process.exit(0);
    }

    const userId = await resolveReversingUser();
    console.log(`\nAPPLY — reversing as user ${userId}\n`);

    let ok = 0;
    let failed = 0;
    for (const r of rows) {
      const companyId = String(r.company_id);
      const jeId = String(r.gl_journal_entry_id);
      const invoiceNumber = String(r.invoice_number);
      try {
        const reversal = await reverseJournalEntry(companyId, jeId, userId);
        ok++;
        console.log(`  OK   ${invoiceNumber}: reversed ${String(r.entry_number)} -> ${reversal.id}`);
      } catch (e) {
        failed++;
        console.error(`  FAIL ${invoiceNumber}:`, e instanceof Error ? e.message : e);
      }
    }

    console.log(`\nDone. Reversed ${ok}, failed ${failed}.`);
    if (failed > 0) {
      console.error(
        'Some reversals failed — a common cause is a CLOSED fiscal period for the ' +
          "original entry's date. Re-open the period (or handle those manually) and re-run.",
      );
      process.exit(1);
    }
    process.exit(0);
  } catch (err) {
    console.error('reverse-cancelled-invoice-journals failed:', err);
    process.exit(1);
  }
})();
