/**
 * Migration 873's re-bind, run inside a transaction that is rolled back: the
 * digest is first put back as 869 defined it, requests are planted against
 * that digest, then 873 runs — twice.
 *
 * A pending or approved request whose stored digest WAS the document's digest
 * keeps clearing (re-bound to 873's); a request already stale stays stale, and
 * a decided-against one is left alone. The supplier payment / batch / manual
 * journal arms digest exactly as 869 defined them. And 873 refuses to run on a
 * schema without 870's columns.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { newCompany, plantBill } from './r035-approval.helpers';
import { plantInvoice } from './r035-pr4.helpers';
import { digestOf, plantDims, type GatedType } from './dims-approval.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
afterAll(() => pool.end());

const MIGRATIONS = path.resolve(__dirname, '../../scripts/migrations/sql');
const migration873 = readFileSync(path.join(MIGRATIONS, '873_approval_digest_dimensions.sql'), 'utf8');
/** approval_document_digest as 869 defined it, under `name`. */
function digest869(name: string): string {
  const text = readFileSync(path.join(MIGRATIONS, '869_manual_journal_approval_enforcement.sql'), 'utf8');
  const start = text.indexOf('CREATE OR REPLACE FUNCTION public.approval_document_digest(');
  expect(start).toBeGreaterThan(-1);
  return text.slice(start, text.indexOf('$$;', start) + 3).replace('public.approval_document_digest(', `${name}(`);
}

async function rolledBack(fn: (client: PoolClient) => Promise<void>): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await fn(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

type Column = 'cc1_id' | 'cc2_id' | 'bu_id';
/** A company with one of each document; `tagged` puts that ONE dimension on each (one invoice / bill line, the note header). */
async function plantAll(client: PoolClient, tagged: Column | null) {
  const user = crypto.randomUUID();
  await client.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  const c = await newCompany(client, [[user, 'owner']]);
  const d = await plantDims(client, c);
  const inv = await plantInvoice(client, c, user);
  const bill = await plantBill(client, c, user);
  const value = tagged && { cc1_id: d.fno1, cc2_id: d.proj1, bu_id: d.bu1 }[tagged];
  if (tagged) {
    await client.query(`UPDATE customer_invoice_items SET ${tagged} = $2 WHERE invoice_id = $1 AND description = 'Line A'`, [inv.id, value]);
    await client.query(`UPDATE supplier_invoice_items SET ${tagged} = $2 WHERE supplier_invoice_id = $1 AND description = 'Line B'`, [bill.id, value]);
  }
  const notes: string[] = [];
  for (const type of ['customer', 'supplier'] as const) {
    const party = crypto.randomUUID();
    await client.query(`INSERT INTO ${type}s(id,company_id,name) VALUES($1,$2,'dims')`, [party, c]);
    notes.push((await client.query(
      `INSERT INTO credit_notes(company_id,credit_note_number,type,client_id,supplier_id,credit_date,subtotal,tax_rate,
         tax_amount,total_amount,status,created_by,cc2_id,bu_id)
       VALUES($1,$2,$3,$4,$5,DATE '2026-09-01',100,15,15,115,'draft',$6,$7,$8) RETURNING id`,
      [c, `CN-${party.slice(0, 8)}`, type, type === 'customer' ? party : null, type === 'supplier' ? party : null,
        user, null, null])).rows[0].id as string);
    if (tagged) await client.query(`UPDATE credit_notes SET ${tagged} = $2 WHERE id = $1`, [notes[notes.length - 1], value]);
  }
  const [expense, bank] = await Promise.all(['expense', 'asset'].map(async (t) => (await client.query(
    `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,normal_balance,is_active)
     VALUES($1,$2,$2,$3,'debit',true) RETURNING id`, [c, `${t}-${c.slice(0, 6)}`, t])).rows[0].id as string));
  const journal = (await client.query(
    `INSERT INTO gl_journal_entries(company_id,entry_number,entry_date,description,source,status,created_by)
     VALUES($1,$2,DATE '2026-09-01','dims','manual','draft',$3) RETURNING id`, [c, `JE-${c.slice(0, 8)}`, user])).rows[0].id as string;
  await client.query(
    `INSERT INTO gl_journal_lines(company_id,journal_entry_id,gl_account_id,debit,credit,description,cc1_id,cc2_id,bu_id)
     VALUES($1,$2,$3,10,0,'dr',$5,$6,$7),($1,$2,$4,0,10,'cr',NULL,NULL,NULL)`, [c, journal, expense, bank, d.fno1, d.proj1, d.bu1]);
  await client.query("UPDATE gl_journal_entries SET approval_document_type = 'manual_journal' WHERE id = $1", [journal]);
  return { c, user, inv: inv.id, bill: bill.id, customerNote: notes[0]!, supplierNote: notes[1]!, journal };
}

/** Raised (and, unless pending, decided) at `at`: by default a day before 870 was applied, when no dimension existed;
 * 'decidedAfter870' raises then and decides now. */
async function request(client: PoolClient, c: string, user: string, type: string, id: string,
  status: string, digest: 'current' | 'stale', at: 'before870' | 'now' | 'decidedAfter870' = 'before870'): Promise<string> {
  return (await client.query(
    `WITH t AS (SELECT CASE WHEN $7 = 'now' THEN now() ELSE (
        SELECT min(applied_at) - INTERVAL '1 day' FROM schema_migrations
        WHERE name IN ('870_dimensions_cc_bu_capture.sql', '870_dimensions_cc_bu_capture')) END AS at)
     INSERT INTO approval_requests(company_id,document_type,document_id,status,requested_by,requested_at,decided_by,decided_at,document_digest)
     SELECT $1,$2,$3::UUID,$4,$5::UUID,t.at,CASE WHEN $4 = 'pending' THEN NULL ELSE $5::UUID END,
            CASE WHEN $4 = 'pending' THEN NULL WHEN $7 = 'decidedAfter870' THEN now() ELSE t.at END,
            CASE $6 WHEN 'current' THEN approval_document_digest($1,$2,$3::UUID) ELSE md5('stale') END
     FROM t RETURNING id`,
    [c, type, id, status, user, digest, at])).rows[0].id as string;
}

const storedDigest = async (client: PoolClient, id: string) =>
  (await client.query('SELECT document_digest FROM approval_requests WHERE id = $1', [id])).rows[0].document_digest as string;

describe('migration 873', () => {
  it('re-binds only an untagged document approved before 870; a tag on any column, a post-870 approval, stale and rejected ones stay', async () => {
    await rolledBack(async (client) => {
      await client.query(digest869('public.approval_document_digest'));
      // The test owns its precondition: 870 applied an hour ago, whatever the fixture's schema_migrations holds.
      await client.query("DELETE FROM schema_migrations WHERE name IN ('870_dimensions_cc_bu_capture.sql', '870_dimensions_cc_bu_capture')");
      await client.query(
        "INSERT INTO schema_migrations(name, version, applied_at) VALUES('870_dimensions_cc_bu_capture.sql', '870', now() - INTERVAL '1 hour')");
      const plain = await plantAll(client, null);
      const tagged = await Promise.all((['cc1_id', 'cc2_id', 'bu_id'] as const).map((col) => plantAll(client, col)));
      const docs = (f: typeof plain) => ([
        ['customer_invoice', f.inv, 'pending'], ['supplier_invoice', f.bill, 'approved'],
        ['customer_credit_note', f.customerNote, 'approved'], ['supplier_credit_note', f.supplierNote, 'pending'],
      ] as [GatedType, string, string][]);
      // 'decidedAfter870' only means something for a decided (approved) request.
      const raise = (f: typeof plain, at: 'before870' | 'now' | 'decidedAfter870' = 'before870') => Promise.all(docs(f)
        .filter(([, , status]) => at !== 'decidedAfter870' || status === 'approved').map(async ([type, id, status]) =>
        [f.c, type, id, await request(client, f.c, f.user, type, id, status, 'current', at)] as const));
      const kept = await raise(plain);
      const held = (await Promise.all(tagged.map((f) => raise(f)))).flat();
      // INV-5: approved AFTER 870, when the document may have carried a dimension since removed, then untagged.
      const untaggedAfter = await plantAll(client, null);
      const late = [...await raise(untaggedAfter, 'now'),
        // Raised before 870 but DECIDED after it: the decision may have covered a dimension since removed.
        ...await raise(await plantAll(client, null), 'decidedAfter870')];
      const stale = await request(client, plain.c, plain.user, 'supplier_credit_note', plain.supplierNote, 'approved', 'stale');
      const rejected = await request(client, plain.c, plain.user, 'customer_invoice', plain.inv, 'rejected', 'current');
      const before = new Map(await Promise.all([...kept, ...held, ...late].map(async ([, , , r]) => [r, await storedDigest(client, r)] as const)));
      const rejectedBefore = await storedDigest(client, rejected);

      for (let run = 1; run <= 2; run++) {
        await client.query(migration873);
        for (const [c, type, id, r] of kept) {
          const now = await digestOf(client, c, type, id);
          expect(now, `${type} run ${run}`).not.toBe(before.get(r));
          expect(await storedDigest(client, r), `${type} re-bound, run ${run}`).toBe(now);
        }
        // A tagged document may have been tagged after approval; a post-870 approval may have covered a
        // dimension since removed. Neither is re-bound: they need re-approval.
        for (const [c, type, id, r] of [...held, ...late]) {
          expect(await storedDigest(client, r), `${type} ${c.slice(0, 6)} left, run ${run}`).toBe(before.get(r));
          expect(await digestOf(client, c, type, id), `${type} ${c.slice(0, 6)} stale, run ${run}`).not.toBe(before.get(r));
        }
        expect(await storedDigest(client, stale)).toBe(await client.query("SELECT md5('stale') AS m").then((x) => x.rows[0].m));
        expect(await storedDigest(client, rejected)).toBe(rejectedBefore);
      }
    });
  });

  it('holds every writer of what it snapshots until it commits', async () => {
    await rolledBack(async (client) => {
      await client.query(migration873);
      const peer = await pool.connect();
      try {
        await peer.query("SET lock_timeout = '300ms'");
        for (const table of ['customer_invoices', 'customer_invoice_items', 'supplier_invoices', 'supplier_invoice_items',
          'credit_notes', 'approval_requests']) {
          // An UPDATE that matches nothing still needs ROW EXCLUSIVE on the table.
          await expect(peer.query(`UPDATE ${table} SET id = id WHERE false`), table).rejects.toThrow(/lock timeout/);
        }
      } finally {
        peer.release();
      }
    });
  });

  it('leaves the manual journal arm as 869 defined it', async () => {
    await rolledBack(async (client) => {
      const f = await plantAll(client, 'cc1_id');
      await client.query(migration873);
      await client.query(digest869('pg_temp.dims_digest_869'));
      const { rows: [r] } = await client.query(
        "SELECT pg_temp.dims_digest_869($1,'manual_journal',$2) AS old, approval_document_digest($1,'manual_journal',$2) AS now",
        [f.c, f.journal]);
      expect(r.old).toMatch(/^[0-9a-f]{64}$/);
      expect(r.now).toBe(r.old);
    });
  });

  it('refuses to run before 870', async () => {
    await rolledBack(async (client) => {
      await client.query('ALTER TABLE credit_notes DROP COLUMN bu_id');
      await expect(client.query(migration873)).rejects.toThrow(/apply 870_dimensions_cc_bu_capture first/);
    });
  });
});
