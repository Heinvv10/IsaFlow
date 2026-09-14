/**
 * K-040 — two overlapping WIP invoice runs must not bill the same time entry.
 *
 * Before the fix `generateWipInvoice` read the eligible entries with no row
 * lock and discarded the count `markEntriesBilled` returned. `withAuth` gives
 * each request its own READ COMMITTED transaction (src/lib/auth/withAuth.ts,
 * plain BEGIN), so an entry billed after this run's eligibility read was
 * invoiced a second time and the zero-row UPDATE went unnoticed.
 *
 * The eligibility read now takes `FOR UPDATE OF te` (wipEntryLock.ts). The
 * second run blocks there; when the first commits, READ COMMITTED re-checks the
 * predicate against the new row version, `billed_at` is set, and the entry
 * leaves the selection before the second run writes anything.
 *
 * Deterministic, not timed: run A is held open after it finishes, run B is
 * observed parked on A's row lock in pg_stat_activity, and only then is A
 * committed.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();

const { als } = await import('@/lib/als');
const { generateWipInvoice } = await import(
  '@/modules/accounting/services/practice/practiceWipService'
);

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companyId = crypto.randomUUID();
const otherCompanyId = crypto.randomUUID();
const clientId = crypto.randomUUID();
const otherClientId = crypto.randomUUID();
const customerId = crypto.randomUUID();
const otherCustomerId = crypto.randomUUID();
const userId = crypto.randomUUID();
const entryId = crypto.randomUUID();
const entry2Id = crypto.randomUUID();
const secondClientId = crypto.randomUUID();
const secondClientEntryId = crypto.randomUUID();
const otherEntryId = crypto.randomUUID();

const ctx = (client: unknown) => ({ client, userId, claims: {} } as never);

async function seedCompany(
  cid: string, cust: string, pcl: string, entry: string, name: string,
): Promise<void> {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [cid, name]);
  await pool.query('INSERT INTO customers(id,company_id,name,is_active) VALUES($1,$2,$3,TRUE)',
    [cust, cid, `${name} Customer`]);
  await pool.query(
    `INSERT INTO practice_clients(id,company_id,legal_name,billing_model,status,link_customer_id)
     VALUES($1,$2,$3,'hourly','active',$4)`,
    [pcl, cid, `${name} Client`, cust]);
  await pool.query(
    `INSERT INTO time_entries(id,company_id,user_id,task_description,entry_date,hours,
       billable,status,practice_client_id,applied_rate,line_total,approved_at)
     VALUES($1,$2,$3,'K-040 billable work','2026-06-01',10,TRUE,'approved',$4,1000,10000,now())`,
    [entry, cid, userId, pcl]);
}

async function purge(cid: string): Promise<void> {
  await pool.query(
    'DELETE FROM customer_invoice_items WHERE invoice_id IN (SELECT id FROM customer_invoices WHERE company_id=$1)',
    [cid]);
  await pool.query('UPDATE time_entries SET invoice_id=NULL WHERE company_id=$1', [cid]);
  await pool.query('DELETE FROM customer_invoices WHERE company_id=$1', [cid]);
}

async function seedEntry(cid: string, pcl: string, entry: string): Promise<void> {
  await pool.query(
    `INSERT INTO time_entries(id,company_id,user_id,task_description,entry_date,hours,
       billable,status,practice_client_id,applied_rate,line_total,approved_at)
     VALUES($1,$2,$3,'K-040 billable work','2026-06-01',10,TRUE,'approved',$4,1000,10000,now())`,
    [entry, cid, userId, pcl]);
}

beforeAll(async () => {
  await seedCompany(companyId, customerId, clientId, entryId, 'K-040');
  await seedCompany(otherCompanyId, otherCustomerId, otherClientId, otherEntryId, 'K-040 Other');
  // A second entry on the same client, and a second client sharing the company's
  // invoice-number sequence.
  await seedEntry(companyId, clientId, entry2Id);
  await pool.query(
    `INSERT INTO practice_clients(id,company_id,legal_name,billing_model,status,link_customer_id)
     VALUES($1,$2,'K-040 Client Two','hourly','active',$3)`,
    [secondClientId, companyId, customerId]);
  await seedEntry(companyId, secondClientId, secondClientEntryId);
});

afterEach(async () => {
  for (const cid of [companyId, otherCompanyId]) {
    await purge(cid);
    await pool.query(
      `UPDATE time_entries SET status='approved', billed_at=NULL, invoice_id=NULL WHERE company_id=$1`,
      [cid]);
  }
});

afterAll(async () => {
  for (const cid of [companyId, otherCompanyId]) {
    await purge(cid);
    await pool.query('DELETE FROM time_entries WHERE company_id=$1', [cid]);
    await pool.query('DELETE FROM practice_clients WHERE company_id=$1', [cid]);
    await pool.query('DELETE FROM customers WHERE company_id=$1', [cid]);
    await pool.query('DELETE FROM companies WHERE id=$1', [cid]);
  }
  await pool.end();
});

/** Resolves once `pid` is parked on a lock. Polls state; never sleeps blindly. */
async function waitUntilBlocked(pid: number): Promise<void> {
  for (let i = 0; i < 400; i++) {
    const { rows } = await pool.query(
      `SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock' AND state='active'`,
      [pid]);
    if (rows.length) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`backend ${pid} never blocked — race setup failed`);
}

const runInvoice = (client: unknown, cid: string, pcl: string, ids: string[]) =>
  als.run(ctx(client), () => generateWipInvoice(cid, userId, {
    practiceClientId: pcl, timeEntryIds: ids, invoiceDate: '2026-06-30',
  }));

describe('K-040 overlapping WIP invoice runs', () => {
  it('bills a time entry on exactly one invoice when two runs overlap', async () => {
    const a = await pool.connect();
    const b = await pool.connect();
    let runB: Promise<{ invoiceId: string }> | undefined;
    try {
      // Run A completes its work but has not committed: it holds the entry lock.
      await a.query('BEGIN');
      const invoiceA = await runInvoice(a, companyId, clientId, [entryId]);

      // Run B starts on the same selection and parks on A's lock.
      await b.query('BEGIN');
      const bPid = Number((await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      runB = runInvoice(b, companyId, clientId, [entryId]);
      await waitUntilBlocked(bPid);

      await a.query('COMMIT');

      // B's lock is granted, the predicate is re-checked, the entry is gone.
      await expect(runB).rejects.toThrow(/no eligible approved time entries/);
      await b.query('COMMIT');

      const { rows: lines } = await pool.query(
        `SELECT count(*)::int AS n FROM customer_invoice_items WHERE time_entry_id=$1`, [entryId]);
      expect(lines[0].n).toBe(1);

      const { rows: invoices } = await pool.query(
        `SELECT count(*)::int AS n FROM customer_invoices WHERE company_id=$1`, [companyId]);
      expect(invoices[0].n).toBe(1);

      const { rows: entry } = await pool.query(
        `SELECT status, invoice_id, billed_at FROM time_entries WHERE id=$1`, [entryId]);
      expect(entry[0].status).toBe('billed');
      expect(entry[0].invoice_id).toBe(invoiceA.invoiceId);
      expect(entry[0].billed_at).not.toBeNull();

      // The single invoice agrees with the hours it billed: 10h @ R1000.
      const { rows: totals } = await pool.query(
        `SELECT ci.subtotal::numeric AS subtotal, ci.total_amount::numeric AS total,
                SUM(cii.amount)::numeric AS line_sum
           FROM customer_invoices ci JOIN customer_invoice_items cii ON cii.invoice_id=ci.id
          WHERE ci.company_id=$1 GROUP BY ci.subtotal, ci.total_amount`, [companyId]);
      expect(Number(totals[0].subtotal)).toBe(10000);
      expect(Number(totals[0].line_sum)).toBe(10000);
      expect(Number(totals[0].total)).toBe(11500);
    } finally {
      if (runB) await runB.catch(() => undefined);
      for (const c of [a, b]) { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
    }
  });

  it('does not block or bill another company holding its own WIP run open', async () => {
    const a = await pool.connect();
    const other = await pool.connect();
    try {
      await a.query('BEGIN');
      await runInvoice(a, companyId, clientId, [entryId]);

      // A different tenant's run must not wait on this company's locks.
      await other.query('BEGIN');
      const result = await runInvoice(other, otherCompanyId, otherClientId, [otherEntryId]);
      await other.query('COMMIT');
      await a.query('COMMIT');

      expect(result.lineCount).toBe(1);
      const { rows } = await pool.query(
        `SELECT te.company_id, te.invoice_id, ci.company_id AS inv_company
           FROM time_entries te JOIN customer_invoices ci ON ci.id = te.invoice_id
          WHERE te.id = ANY($1::uuid[])`, [[entryId, otherEntryId]]);
      expect(rows).toHaveLength(2);
      for (const r of rows) expect(r.inv_company).toBe(r.company_id);
    } finally {
      for (const c of [a, other]) { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
    }
  });

  it('writes nothing when the selection holds no eligible entry', async () => {
    const a = await pool.connect();
    try {
      await a.query('BEGIN');
      await pool.query(
        `UPDATE time_entries SET status='billed', billed_at=now() WHERE id=$1`, [entryId]);
      await expect(runInvoice(a, companyId, clientId, [entryId]))
        .rejects.toThrow(/no eligible approved time entries/);
      await a.query('COMMIT');
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM customer_invoices WHERE company_id=$1`, [companyId]);
      expect(rows[0].n).toBe(0);
    } finally {
      await a.query('ROLLBACK').catch(() => undefined);
      a.release();
    }
  });

  it('refuses the run rather than half-billing when the lock cannot be taken', async () => {
    const holder = await pool.connect();
    const b = await pool.connect();
    try {
      // Hold the entry without ever releasing it, so B's 5s lock_timeout fires.
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM time_entries WHERE id=$1 FOR UPDATE', [entryId]);

      await b.query('BEGIN');
      await expect(runInvoice(b, companyId, clientId, [entryId]))
        .rejects.toThrow(/being invoiced by another request/);
      await b.query('ROLLBACK');
      await holder.query('ROLLBACK');

      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM customer_invoices WHERE company_id=$1`, [companyId]);
      expect(rows[0].n).toBe(0);
    } finally {
      for (const c of [holder, b]) { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
    }
  }, 20000);

  it('bills only the entries a peer did not take when the selections overlap partly', async () => {
    const a = await pool.connect();
    const b = await pool.connect();
    let runB: Promise<{ invoiceId: string; invoiceNumber: string; lineCount: number; subtotal: number }> | undefined;
    try {
      // A takes one of the two entries and holds its transaction open.
      await a.query('BEGIN');
      const invoiceA = await runInvoice(a, companyId, clientId, [entryId]);

      // B wants both. It parks on A's row lock, not on an invoice number.
      await b.query('BEGIN');
      const bPid = Number((await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      runB = runInvoice(b, companyId, clientId, [entryId, entry2Id]);
      await waitUntilBlocked(bPid);

      await a.query('COMMIT');
      const invoiceB = await runB;
      await b.query('COMMIT');

      // B billed the entry it won, on an invoice number of its own.
      expect(invoiceB.lineCount).toBe(1);
      expect(invoiceB.subtotal).toBe(10000);
      expect(invoiceB.invoiceNumber).not.toBe(invoiceA.invoiceNumber);

      const { rows } = await pool.query(
        `SELECT te.id, te.status, te.invoice_id,
                (SELECT count(*)::int FROM customer_invoice_items WHERE time_entry_id=te.id) AS lines
           FROM time_entries te WHERE te.id = ANY($1::uuid[]) ORDER BY te.id`,
        [[entryId, entry2Id].sort()]);
      expect(rows).toHaveLength(2);
      for (const r of rows) {
        expect(r.status).toBe('billed');
        expect(r.lines).toBe(1);
      }
      const byId = Object.fromEntries(rows.map((r) => [r.id, r.invoice_id]));
      expect(byId[entryId]).toBe(invoiceA.invoiceId);
      expect(byId[entry2Id]).toBe(invoiceB.invoiceId);
    } finally {
      if (runB) await runB.catch(() => undefined);
      for (const c of [a, b]) { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
    }
  });

  it('serialises two runs on the company number sequence and issues contiguous numbers', async () => {
    const a = await pool.connect();
    const b = await pool.connect();
    let runB: Promise<{ invoiceNumber: string; invoiceId: string }> | undefined;
    try {
      // Two runs, different practice clients, one company: no time-entry row-lock
      // contention, but they compete for the same company_document_numbers row.
      // Since K-107/K-120 the number is reserved from that sequence rather than
      // read as MAX(invoice_number)+1, so B parks on the counter row's lock.
      await a.query('BEGIN');
      const invoiceA = await runInvoice(a, companyId, clientId, [entryId]);

      await b.query('BEGIN');
      const bPid = Number((await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      runB = runInvoice(b, companyId, secondClientId, [secondClientEntryId]);
      await waitUntilBlocked(bPid); // parked on A's company_document_numbers row lock

      await a.query('COMMIT');

      // A's COMMIT releases the counter row; B's reservation then reads the
      // advanced value.
      const invoiceB = await runB;
      await b.query('COMMIT');

      // Both numbers come from the company sequence, and they are CONTIGUOUS:
      // the counter is advanced exactly once per invoice, so a serialised loser
      // takes the very next number rather than skipping one. Asserted
      // relatively — this suite does not reset company_document_numbers between
      // tests, so the absolute values depend on what ran before.
      const { rows: seq } = await pool.query(
        `SELECT prefix, padding FROM company_document_numbers
          WHERE company_id=$1 AND document_type='customer_invoice'`, [companyId]);
      const { prefix, padding } = seq[0];
      const numeric = (n: string): number => {
        expect(n.startsWith(prefix)).toBe(true);
        return Number(n.slice(String(prefix).length));
      };
      expect(String(invoiceA.invoiceNumber).length)
        .toBe(String(prefix).length + Number(padding));
      expect(numeric(invoiceB.invoiceNumber)).toBe(numeric(invoiceA.invoiceNumber) + 1);

      const { rows } = await pool.query(
        `SELECT te.id, te.status, te.invoice_id FROM time_entries te
          WHERE te.id = ANY($1::uuid[])`, [[entryId, secondClientEntryId]]);
      expect(rows).toHaveLength(2);
      for (const r of rows) expect(r.status).toBe('billed');
      expect(rows.find((r) => r.id === entryId)!.invoice_id).toBe(invoiceA.invoiceId);
      expect(rows.find((r) => r.id === secondClientEntryId)!.invoice_id).toBe(invoiceB.invoiceId);
    } finally {
      if (runB) await runB.catch(() => undefined);
      for (const c of [a, b]) { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
    }
  });
});
