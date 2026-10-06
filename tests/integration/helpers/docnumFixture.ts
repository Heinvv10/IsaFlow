/**
 * DOCNUM (document numbering under concurrency) — the eight BEFORE INSERT numbering triggers fixed by migration
 * 858, as a table the docnum-*.int.test.ts files iterate over, plus the scope they insert into.
 *
 * Every insert goes straight at the table on a dedicated `pg.Client`, so the trigger is the only code under test.
 * Each case's SQL takes exactly the parameters it binds: $1 the scope id (company or group), then the row date
 * where the trigger reads its year from one, then the number — NULL lets the trigger mint it, a string is an
 * explicit number (the trigger skips).
 */
import { Client } from 'pg';
import { randomUUID } from 'crypto';

export interface Scope { companyId: string; customerId: string; supplierId: string; invoiceId: string; groupId: string }

export interface NumberingCase {
  fn: string;
  table: string;
  prefix: string;
  /** True when the trigger reads the year from the row's date; false = CURRENT_DATE. */
  datedRow: boolean;
  /** The id the trigger's MAX filters on: the company, or the consolidation group. */
  scopeOf: (s: Scope) => string;
  sql: string;
  /** Bound after the scope id (and the date, when `datedRow`): whatever else the row needs. */
  extra: (s: Scope) => unknown[];
}

const actor = (): string => randomUUID();

export const CASES: NumberingCase[] = [
  {
    fn: 'generate_credit_note_number', table: 'credit_notes', prefix: 'CN', datedRow: true,
    scopeOf: (s) => s.companyId, extra: () => [actor()],
    sql: `INSERT INTO credit_notes (company_id, credit_date, credit_note_number, type, created_by)
          VALUES ($1, $2, $3, 'customer', $4) RETURNING credit_note_number AS n`,
  },
  {
    fn: 'generate_customer_payment_number', table: 'customer_payments', prefix: 'CP', datedRow: true,
    scopeOf: (s) => s.companyId, extra: (s) => [s.customerId, actor()],
    sql: `INSERT INTO customer_payments (company_id, payment_date, payment_number, client_id, total_amount, created_by)
          VALUES ($1, $2, $3, $4, 1, $5) RETURNING payment_number AS n`,
  },
  {
    fn: 'generate_supplier_payment_number', table: 'supplier_payments', prefix: 'SP', datedRow: true,
    scopeOf: (s) => s.companyId, extra: (s) => [s.supplierId, actor()],
    sql: `INSERT INTO supplier_payments (company_id, payment_date, payment_number, supplier_id, total_amount, created_by)
          VALUES ($1, $2, $3, $4, 1, $5) RETURNING payment_number AS n`,
  },
  {
    fn: 'generate_consolidation_adj_number', table: 'consolidation_adjustments', prefix: 'ELIM', datedRow: true,
    scopeOf: (s) => s.groupId, extra: () => [],
    sql: `INSERT INTO consolidation_adjustments (group_id, period_start, adjustment_number, adjustment_type)
          VALUES ($1, $2, $3, 'interco_balance') RETURNING adjustment_number AS n`,
  },
  {
    fn: 'generate_adjustment_number', table: 'accounting_adjustments', prefix: 'ADJ', datedRow: false,
    scopeOf: (s) => s.companyId, extra: (s) => [s.customerId, actor()],
    sql: `INSERT INTO accounting_adjustments
            (company_id, adjustment_number, entity_type, entity_id, adjustment_type, amount, reason, created_by)
          VALUES ($1, $2, 'customer', $3, 'debit', 1, 'docnum', $4) RETURNING adjustment_number AS n`,
  },
  {
    fn: 'generate_batch_number', table: 'supplier_payment_batches', prefix: 'BAT', datedRow: false,
    scopeOf: (s) => s.companyId, extra: () => [actor()],
    sql: `INSERT INTO supplier_payment_batches (company_id, batch_number, created_by)
          VALUES ($1, $2, $3) RETURNING batch_number AS n`,
  },
  {
    fn: 'generate_vat_adjustment_number', table: 'vat_adjustments', prefix: 'VA', datedRow: false,
    scopeOf: (s) => s.companyId, extra: () => [actor()],
    sql: `INSERT INTO vat_adjustments (company_id, adjustment_number, adjustment_type, amount, reason, created_by)
          VALUES ($1, $2, 'input', 1, 'docnum', $3) RETURNING adjustment_number AS n`,
  },
  {
    fn: 'generate_write_off_number', table: 'customer_write_offs', prefix: 'WO', datedRow: false,
    scopeOf: (s) => s.companyId, extra: (s) => [s.customerId, s.invoiceId, actor()],
    sql: `INSERT INTO customer_write_offs (company_id, write_off_number, client_id, invoice_id, amount, reason, created_by)
          VALUES ($1, $2, $3, $4, 1, 'docnum', $5) RETURNING write_off_number AS n`,
  },
];

/** Inserts one row for `k` in scope `s`; `number` null = minted by the trigger. Returns the stored number. */
export async function insertDoc(
  c: Client, k: NumberingCase, s: Scope, year: number, number: string | null = null,
): Promise<string> {
  const head = k.datedRow ? [k.scopeOf(s), `${year}-03-01`, number] : [k.scopeOf(s), number];
  return String((await c.query(k.sql, [...head, ...k.extra(s)])).rows[0].n);
}

/** A draft journal with a trigger-minted number, dated in `year` (no lines: only its number matters here). */
export async function insertJournal(c: Client, s: Scope, year: number): Promise<string> {
  return String((await c.query(`
    INSERT INTO gl_journal_entries (company_id, entry_date, description, source, status, created_by)
    VALUES ($1, $2, 'docnum', 'manual', 'draft', $3) RETURNING entry_number AS n`,
  [s.companyId, `${year}-03-01`, randomUUID()])).rows[0].n);
}

/** A company with a customer, a supplier, one customer invoice (write-offs need it) and a consolidation group. */
export async function seedScope(c: Client, tag: string): Promise<Scope> {
  const s: Scope = {
    companyId: randomUUID(), customerId: randomUUID(), supplierId: randomUUID(), invoiceId: randomUUID(),
    groupId: randomUUID(),
  };
  const name = `${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await c.query('INSERT INTO companies (id, name, registration_number, created_at) VALUES ($1, $2, $2, NOW())',
    [s.companyId, name]);
  await c.query('INSERT INTO customers (id, name, company_id) VALUES ($1, $2, $3)', [s.customerId, name, s.companyId]);
  await c.query('INSERT INTO suppliers (id, name, company_id) VALUES ($1, $2, $3)', [s.supplierId, name, s.companyId]);
  await c.query(`
    INSERT INTO customer_invoices (id, company_id, customer_id, client_id, invoice_number, created_by)
    VALUES ($1, $2, $3, $3, $4, $5)`, [s.invoiceId, s.companyId, s.customerId, `DOCNUM-${name}`, randomUUID()]);
  await c.query('INSERT INTO company_groups (id, name, holding_company_id) VALUES ($1, $2, $3)',
    [s.groupId, name, s.companyId]);
  return s;
}

/** Deletes everything `seedScope` and the tests wrote for `s`. */
export async function dropScope(c: Client, s: Scope): Promise<void> {
  await c.query('DELETE FROM consolidation_adjustments WHERE group_id = $1', [s.groupId]);
  await c.query('DELETE FROM company_groups WHERE id = $1', [s.groupId]);
  for (const t of ['credit_notes', 'customer_payments', 'supplier_payments', 'accounting_adjustments',
    'supplier_payment_batches', 'vat_adjustments', 'customer_write_offs', 'gl_journal_entries', 'customer_invoices',
    'customers', 'suppliers']) {
    await c.query(`DELETE FROM ${t} WHERE company_id = $1`, [s.companyId]);
  }
  await c.query('DELETE FROM companies WHERE id = $1', [s.companyId]);
}

export async function pidOf(c: Client): Promise<number> {
  return Number((await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
}

/**
 * True once `waiterPid` is blocked by `holderPid`; false if `p` (the waiter's statement) settles first without
 * ever being seen blocked. Scoped by pid: the fixture database is shared with other runs.
 */
export async function blockedBeforeSettling(
  admin: Client, holderPid: number, waiterPid: number, p: Promise<unknown>, ms = 15000,
): Promise<boolean> {
  let settled = false;
  void p.then(() => { settled = true; }, () => { settled = true; });
  const deadline = Date.now() + ms;
  for (;;) {
    const r = await admin.query('SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS b', [holderPid, waiterPid]);
    if (r.rows[0].b) return true;
    if (settled) return false;
    if (Date.now() > deadline) throw new Error(`pid ${waiterPid} neither blocked on ${holderPid} nor finished`);
    await new Promise((resolve) => { setTimeout(resolve, 25); });
  }
}

export type Outcome = { ok: true; value: string } | { ok: false; error: unknown };

export function settle(p: Promise<string>): Promise<Outcome> {
  return p.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
}

/** `CN-2031-00007` → `CN-2031-00008`. */
export function nextNumber(n: string): string {
  const [prefix, year, seq] = n.split('-');
  return `${prefix}-${year}-${String(Number(seq) + 1).padStart(5, '0')}`;
}

export function errText(e: unknown): string {
  const x = e as { code?: string; constraint?: string; message?: string };
  return `${x?.code ?? ''} ${x?.constraint ?? ''} ${x?.message ?? String(e)}`;
}
