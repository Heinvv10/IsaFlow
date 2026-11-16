/**
 * Post-checks over names and numbers (PLAN 7.2, N1 to N5). Read-only.
 */

import type { CheckResult } from '../integrityTypes';
import { DEMO_COMPANY_NAME } from './constants';
import type { Tx } from './db';
import { ISO_DATE_IN_TEXT, findDeniedNames } from './denylist';
import { DEFAULT_PREFIX } from './write';
import { isAppendOnlyKept } from './wipePlan';
import { keptReport } from './wipe';

/** [table, text columns, scope]: the Demo text a user can see. Child tables are reached through their parent. */
export const TEXT_SURFACES: ReadonlyArray<readonly [string, readonly string[], string]> = [
  ['companies', ['name', 'trading_name', 'registered_name', 'bank_name', 'email', 'website'], 'id = $1::uuid'],
  ['customers', ['name', 'email', 'contact_person', 'billing_address', 'notes'], 'company_id = $1::uuid'],
  ['customer_contacts', ['full_name', 'email'], 'company_id = $1::uuid'],
  ['suppliers', ['name', 'company_name', 'email', 'contact_person', 'address', 'bank_name', 'notes'], 'company_id = $1::uuid'],
  ['items', ['code', 'description'], 'company_id = $1::uuid'],
  ['payroll_employees', ['first_name', 'last_name', 'occupation'], 'company_id = $1::uuid'],
  ['practice_clients', ['legal_name', 'trading_name'], 'company_id = $1::uuid'],
  ['practice_client_contacts', ['name', 'email'], 'company_id = $1::uuid'],
  ['practice_jobs', ['title'], 'company_id = $1::uuid'],
  ['time_entries', ['task_description'], 'company_id = $1::uuid'],
  ['assets', ['name', 'description'], 'company_id = $1::uuid'],
  ['gl_accounts', ['account_name', 'bank_name', 'bank_branch_name', 'description'], 'company_id = $1::uuid'],
  ['bank_transactions', ['description', 'reference'], 'company_id = $1::uuid'],
  ['gl_journal_entries', ['description', 'reference'], 'company_id = $1::uuid'],
  ['gl_journal_lines', ['description'], 'company_id = $1::uuid'],
  ['customer_invoices', ['invoice_number', 'notes'], 'company_id = $1::uuid'],
  ['customer_invoice_items', ['description'], 'invoice_id IN (SELECT id FROM customer_invoices WHERE company_id = $1::uuid)'],
  ['supplier_invoices', ['invoice_number', 'reference', 'notes'], 'company_id = $1::uuid'],
  ['supplier_invoice_items', ['description'], 'supplier_invoice_id IN (SELECT id FROM supplier_invoices WHERE company_id = $1::uuid)'],
  ['customer_quotes', ['customer_name', 'notes'], 'company_id = $1::uuid'],
  ['expense_claims', ['title', 'description'], 'company_id = $1::uuid'],
  ['expense_claim_lines', ['description', 'merchant'], 'company_id = $1::uuid'],
  ['bank_categorisation_rules', ['rule_name'], 'company_id = $1::uuid'],
];

interface Hit { table: string; column: string; id: string; term: string }

async function scanText(tx: Tx, companyId: string, test: (text: string) => string[]): Promise<Hit[]> {
  const hits: Hit[] = [];
  for (const [table, cols, scope] of TEXT_SURFACES) {
    const have = await tx.query<{ c: string }>(
      `SELECT column_name AS c FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`, [table]);
    const present = cols.filter((c) => have.some((h) => h.c === c));
    if (present.length === 0) continue;
    const rows = await tx.query<Record<string, string | null>>(
      `SELECT id::text AS id, ${present.map((c) => `${c}::text AS ${c}`).join(', ')} FROM ${table} WHERE ${scope}`, [companyId]);
    for (const r of rows) {
      for (const c of present) {
        const v = r[c];
        if (v) for (const term of test(v)) hits.push({ table, column: c, id: String(r.id), term });
      }
    }
  }
  return hits;
}

function fromHits(label: string, hits: Hit[], clean: string): CheckResult {
  if (hits.length === 0) return { label, status: 'pass', detail: clean };
  return {
    label, status: 'fail', offending: hits.length, detail: `${hits.length} match(es)`,
    lines: hits.slice(0, 25).map((h) => `${h.table}.${h.column} id=${h.id.slice(0, 8)} matched "${h.term}"`),
  };
}

export async function checkN1(tx: Tx, companyId: string): Promise<CheckResult> {
  return fromHits('N1 Real-name denylist', await scanText(tx, companyId, findDeniedNames), 'no denylisted name in Demo text');
}

export async function checkN2(tx: Tx, companyId: string): Promise<CheckResult> {
  const rows = await tx.query<{ t: string; v: string }>(`
    SELECT 'customers' AS t, name AS v FROM customers WHERE company_id = $1::uuid AND (name ILIKE '0GP%Golden%' OR name ILIKE '%[MERGED]%' OR name ILIKE '%eskom%')
    UNION ALL SELECT 'suppliers', name FROM suppliers WHERE company_id = $1::uuid AND (name ILIKE '0GP%Golden%' OR name ILIKE '%[MERGED]%' OR name ILIKE '%eskom%')
    UNION ALL SELECT 'assets', name FROM assets WHERE company_id = $1::uuid AND (name ILIKE '0GP%Golden%' OR asset_number ILIKE '0GP%')
    UNION ALL SELECT 'expense_claims', coalesce(title, description, '') FROM expense_claims WHERE company_id = $1::uuid
      AND (coalesce(title, '') || ' ' || coalesce(description, '')) ~* '(qa demo claim|phase 10 e2e retest)'
    UNION ALL SELECT 'practice_clients', legal_name FROM practice_clients WHERE company_id = $1::uuid AND legal_name ILIKE 'DEMO UX Practice Client'
    UNION ALL SELECT 'imap_mirror_connections', display_name FROM imap_mirror_connections WHERE company_id = $1::uuid AND display_name ILIKE 'QA Demo Mailbox'`,
  [companyId]);
  if (rows.length === 0) return { label: 'N2 QA artefacts', status: 'pass', detail: 'none' };
  return { label: 'N2 QA artefacts', status: 'fail', offending: rows.length, detail: `${rows.length} artefact(s)`, lines: rows.map((r) => `${r.t}: ${r.v}`) };
}

export async function checkN3(tx: Tx, companyId: string): Promise<CheckResult> {
  const [r] = await tx.query<{ name: string }>('SELECT name FROM companies WHERE id = $1::uuid', [companyId]);
  return r?.name === DEMO_COMPANY_NAME
    ? { label: 'N3 Company name', status: 'pass', detail: DEMO_COMPANY_NAME }
    : { label: 'N3 Company name', status: 'fail', offending: 1, detail: `name is "${r?.name ?? '(no row)'}"` };
}

/** Seeded number families: [document type, table, number column]. */
const FAMILIES: ReadonlyArray<readonly [keyof typeof DEFAULT_PREFIX, string, string]> = [
  ['customer_invoice', 'customer_invoices', 'invoice_number'], ['customer_receipt', 'customer_payments', 'payment_number'],
  ['supplier_payment', 'supplier_payments', 'payment_number'], ['quotation', 'customer_quotes', 'quote_number'],
];

export async function checkN4(tx: Tx, companyId: string): Promise<CheckResult> {
  const lines: string[] = [];
  for (const [type, table, col] of FAMILIES) {
    const [cfg] = await tx.query<{ prefix: string; next_number: number }>(
      'SELECT prefix, next_number FROM company_document_numbers WHERE company_id = $1::uuid AND document_type = $2', [companyId, type]);
    const [r] = await tx.query<{ hi: number | null; dups: number }>(`
      SELECT max(NULLIF(regexp_replace(${col}, '^' || $2, ''), '')::bigint) FILTER (WHERE ${col} ~ ('^' || $2 || '[0-9]+$')) AS hi,
             (count(*) - count(DISTINCT ${col}))::int AS dups
      FROM ${table} WHERE company_id = $1::uuid`, [companyId, cfg?.prefix ?? DEFAULT_PREFIX[type]]);
    if ((r?.dups ?? 0) > 0) lines.push(`${table}: ${r!.dups} duplicate ${col}`);
    if (r?.hi != null && (!cfg || Number(r.hi) >= Number(cfg.next_number))) {
      lines.push(`${type}: highest ${r.hi} >= next_number ${cfg?.next_number ?? '(no counter)'}`);
    }
  }
  return lines.length === 0
    ? { label: 'N4 Document counters', status: 'pass', detail: 'every counter is above its highest number; no duplicates' }
    : { label: 'N4 Document counters', status: 'fail', offending: lines.length, detail: `${lines.length} problem(s)`, lines };
}

export async function checkN5(tx: Tx, companyId: string): Promise<CheckResult> {
  const hits = await scanText(tx, companyId, (t) => (ISO_DATE_IN_TEXT.test(t) ? [t.match(ISO_DATE_IN_TEXT)![0]] : []));
  return fromHits('N5 No ISO-style date in text', hits, 'no full ISO-style date in Demo text');
}

/**
 * N6: every kept table that is not append-only, scanned whole (each row as JSON) for denylisted names. The reseed
 * does not rewrite these rows, so a real name or QA artefact left in one (a budget name, an approval reference, an
 * e-mail subject) must fail the run rather than pass silently. Append-only tables are R1's residual report.
 */
export async function checkN6(tx: Tx, companyId: string): Promise<CheckResult> {
  const hits: Hit[] = [];
  for (const { table } of await keptReport(tx, companyId)) {
    if (isAppendOnlyKept(table)) continue;
    const rows = await tx.query<{ id: string; j: string }>(
      `SELECT coalesce(to_jsonb(x)->>'id', '') AS id, to_jsonb(x)::text AS j FROM ${table} x WHERE company_id = $1::uuid`, [companyId]);
    for (const r of rows) for (const term of findDeniedNames(r.j)) hits.push({ table, column: '*', id: r.id, term });
  }
  return fromHits('N6 Kept tables carry no denylisted name', hits, 'no denylisted name in any kept, non-append-only table');
}
