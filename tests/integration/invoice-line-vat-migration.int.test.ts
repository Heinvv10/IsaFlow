/**
 * Per-line VAT on customer invoices, the schema half: migration 1008's three columns and their CHECKs; and 1009's
 * approval digest, whose customer_invoice arm covers them (zero-rated and exempt both carry rate 0 yet post to
 * different VAT201 fields), with 874's procedure for a digest change run here as the deploy runs it: with 923's body put
 * back under 951's name (rolled back afterwards), a pending or approved request bound to the invoice as it stood is
 * re-bound, a stale or decided-against one is left alone, no other document type's digest moves, and a second run
 * changes nothing. 1009 accepts exactly two bodies by md5(prosrc), 923's and its own, recomputed here from the files.
 * The function stays a plain STABLE SQL function, not a SECURITY DEFINER one.
 *
 * Disposable fixture DB only; one file at a time (it replaces a function database-wide inside its transactions).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { newCompany, plantBill } from './r035-approval.helpers';
import { plantInvoice } from './r035-pr4.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
afterAll(() => pool.end());

const MIGRATIONS = path.resolve(__dirname, '../../scripts/migrations/sql');
const DIGEST_FILE = '1009_customer_invoice_digest_line_vat.sql';
const MIGRATION = readFileSync(path.join(MIGRATIONS, DIGEST_FILE), 'utf8');
const PRE_951 = 'public.approval_document_digest_pre_payroll_951';
/** The CREATE OR REPLACE of `fn` as `file` defines it, renamed to `name`. */
function functionAsIn(file: string, fn: string, name: string): string {
  const text = readFileSync(path.join(MIGRATIONS, file), 'utf8');
  const start = text.indexOf(`CREATE OR REPLACE FUNCTION ${fn}(`);
  expect(start).toBeGreaterThan(-1);
  return text.slice(start, text.indexOf('\n$$;', start) + 4).replace(`${fn}(`, `${name}(`);
}
const digestAsIn = (file: string, name: string) => functionAsIn(file, 'public.approval_document_digest', name);
/** pg_proc.prosrc of a CREATE OR REPLACE statement: the text between `AS $$` and `$$;`. */
const prosrcOf = (statement: string) => statement.slice(statement.indexOf('AS $$') + 5, statement.lastIndexOf('$$;'));
const md5 = (text: string) => createHash('md5').update(text).digest('hex');
const BODY_923 = digestAsIn('923_payment_digest_payee_name_originator.sql', PRE_951);
const BODY_1009 = functionAsIn(DIGEST_FILE, PRE_951, PRE_951);

async function rolledBack<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    return await fn(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

async function plantCompany(client: PoolClient): Promise<{ c: string; user: string }> {
  const user = crypto.randomUUID();
  await client.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  return { c: await newCompany(client, [[user, 'owner']]), user };
}

const digestOf = async (client: PoolClient, c: string, type: string, id: string) =>
  (await client.query('SELECT approval_document_digest($1,$2,$3) AS d', [c, type, id])).rows[0].d as string;

async function request(client: PoolClient, c: string, user: string, type: string, id: string, status: string,
  digest: 'current' | 'stale'): Promise<string> {
  return (await client.query(
    `INSERT INTO approval_requests(company_id,document_type,document_id,status,requested_by,decided_by,decided_at,document_digest)
     VALUES($1,$2,$3::UUID,$4,$5::UUID,CASE WHEN $4 = 'pending' THEN NULL ELSE $5::UUID END,
            CASE WHEN $4 = 'pending' THEN NULL ELSE now() END,
            CASE $6 WHEN 'current' THEN approval_document_digest($1,$2,$3::UUID) ELSE md5('stale') END)
     RETURNING id`, [c, type, id, status, user, digest])).rows[0].id as string;
}
const stored = async (client: PoolClient, id: string) =>
  (await client.query('SELECT document_digest FROM approval_requests WHERE id = $1', [id])).rows[0].document_digest as string;

/** The migration in the caller's transaction, as apply-migrations runs it; its notices. */
async function migrate(client: PoolClient): Promise<string[]> {
  const notices: string[] = [];
  const onNotice = (n: { message?: string }) => notices.push(n.message ?? '');
  client.on('notice', onNotice);
  try {
    await client.query(MIGRATION);
  } finally {
    client.off('notice', onNotice);
  }
  return notices.filter((n) => n.startsWith('migration 1009'));
}

const liveMd5 = async (client: Pool | PoolClient) => (await client.query(
  `SELECT md5(prosrc) AS h FROM pg_proc WHERE oid = '${PRE_951}(uuid,text,uuid)'::regprocedure`)).rows[0].h as string;

const sqlState = (fn: () => Promise<unknown>) => fn().then(() => 'ok', (e: { code?: string }) => e.code ?? 'error');

describe('migration 1008: per-line VAT columns', () => {
  it('adds the three nullable columns', async () => {
    const { rows } = await pool.query(`
      SELECT table_name, column_name, data_type, numeric_precision, numeric_scale, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public' AND (table_name, column_name) IN
        (('customer_invoice_items', 'vat_type'), ('customer_invoice_items', 'tax_amount'), ('customer_invoices', 'amounts_are'))
      ORDER BY table_name, column_name`);
    expect(rows).toEqual([
      { table_name: 'customer_invoice_items', column_name: 'tax_amount', data_type: 'numeric', numeric_precision: 15,
        numeric_scale: 2, is_nullable: 'YES', column_default: null },
      { table_name: 'customer_invoice_items', column_name: 'vat_type', data_type: 'text', numeric_precision: null,
        numeric_scale: null, is_nullable: 'YES', column_default: null },
      { table_name: 'customer_invoices', column_name: 'amounts_are', data_type: 'text', numeric_precision: null,
        numeric_scale: null, is_nullable: 'YES', column_default: null },
    ]);
  });

  it('refuses a row breaking each CHECK, and takes a well-formed typed line', async () => {
    await rolledBack(async (client) => {
      const { c, user } = await plantCompany(client);
      const inv = await plantInvoice(client, c, user);
      const line = (vatType: string | null, tax: number | null) => sqlState(async () => {
        await client.query('SAVEPOINT s');
        try {
          await client.query(`INSERT INTO customer_invoice_items(invoice_id,description,quantity,unit_price,amount,tax_rate,vat_type,tax_amount)
            VALUES($1,'x',1,100,100,15,$2,$3)`, [inv.id, vatType, tax]);
        } finally {
          await client.query('ROLLBACK TO SAVEPOINT s');
        }
      });
      expect(await line('standard', 15)).toBe('ok');
      expect(await line('exempt', 0)).toBe('ok');
      expect(await line(null, null)).toBe('ok');
      expect(await line('zero', 0)).toBe('23514'); // a legacy spelling is not the ledger's
      expect(await line('standard', null)).toBe('23514');
      expect(await line(null, 15)).toBe('23514');
      const header = (value: string | null) => sqlState(async () => {
        await client.query('SAVEPOINT h');
        try {
          await client.query('UPDATE customer_invoices SET amounts_are = $2 WHERE id = $1', [inv.id, value]);
        } finally {
          await client.query('ROLLBACK TO SAVEPOINT h');
        }
      });
      expect(await header('inclusive')).toBe('ok');
      expect(await header('exclusive')).toBe('ok');
      expect(await header('gross')).toBe('23514');
    });
  });
});

describe('migration 1008: the approval digest', () => {
  it('is a plain STABLE function, wrapper and body alike, neither SECURITY DEFINER', async () => {
    const { rows } = await pool.query(`
      SELECT p.oid::regprocedure::TEXT AS fn, p.prosecdef AS definer, p.provolatile AS volatility, l.lanname AS lang
      FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
      WHERE p.oid IN ('public.approval_document_digest(uuid,text,uuid)'::regprocedure,
                      '${PRE_951}(uuid,text,uuid)'::regprocedure)
      ORDER BY p.oid::regprocedure::TEXT COLLATE "C"`);
    expect(rows).toEqual([
      { fn: 'approval_document_digest(uuid,text,uuid)', definer: false, volatility: 's', lang: 'sql' },
      { fn: 'approval_document_digest_pre_payroll_951(uuid,text,uuid)', definer: false, volatility: 's', lang: 'sql' },
    ]);
  });

  it('moves with a line\'s VAT type, its tax_amount and the header\'s amounts_are: zero-rated and exempt differ', async () => {
    await rolledBack(async (client) => {
      const { c, user } = await plantCompany(client);
      const inv = await plantInvoice(client, c, user);
      const digest = () => digestOf(client, c, 'customer_invoice', inv.id);
      const legacy = await digest();
      expect(await digest()).toBe(legacy);
      await client.query("UPDATE customer_invoice_items SET vat_type = 'zero_rated', tax_amount = 0 WHERE invoice_id = $1", [inv.id]);
      const zeroRated = await digest();
      await client.query("UPDATE customer_invoice_items SET vat_type = 'exempt' WHERE invoice_id = $1", [inv.id]);
      const exempt = await digest();
      await client.query("UPDATE customer_invoice_items SET tax_amount = 0.01 WHERE invoice_id = $1 AND description = 'Line A'", [inv.id]);
      const taxed = await digest();
      await client.query("UPDATE customer_invoices SET amounts_are = 'inclusive' WHERE id = $1", [inv.id]);
      const inclusive = await digest();
      expect(new Set([legacy, zeroRated, exempt, taxed, inclusive]).size).toBe(5);
    });
  });

  it('re-binds pending and approved invoice requests bound to the content as it stood; stale, rejected and other types stay', async () => {
    await rolledBack(async (client) => {
      await client.query(BODY_923);
      const { c, user } = await plantCompany(client);
      const [a, b, s, r] = [await plantInvoice(client, c, user), await plantInvoice(client, c, user),
        await plantInvoice(client, c, user), await plantInvoice(client, c, user)];
      const bill = await plantBill(client, c, user);
      const pending = await request(client, c, user, 'customer_invoice', a.id, 'pending', 'current');
      const approved = await request(client, c, user, 'customer_invoice', b.id, 'approved', 'current');
      const stale = await request(client, c, user, 'customer_invoice', s.id, 'pending', 'stale');
      const rejected = await request(client, c, user, 'customer_invoice', r.id, 'rejected', 'current');
      const billRequest = await request(client, c, user, 'supplier_invoice', bill.id, 'pending', 'current');
      const before = {
        pending: await stored(client, pending), approved: await stored(client, approved), stale: await stored(client, stale),
        rejected: await stored(client, rejected), bill: await stored(client, billRequest),
        billDigest: await digestOf(client, c, 'supplier_invoice', bill.id),
      };

      const notices = await migrate(client);

      expect(notices).toEqual([expect.stringMatching(/^migration 1009: customer_invoice approval_requests re-bound \d+, left stale \d+$/)]);
      for (const [id, inv, was] of [[pending, a, before.pending], [approved, b, before.approved]] as const) {
        const now = await digestOf(client, c, 'customer_invoice', inv.id);
        expect(now).not.toBe(was);
        expect(await stored(client, id)).toBe(now);
      }
      expect(await stored(client, stale)).toBe(before.stale);
      expect(await stored(client, rejected)).toBe(before.rejected);
      expect(await digestOf(client, c, 'customer_invoice', r.id)).not.toBe(before.rejected);
      expect(await digestOf(client, c, 'supplier_invoice', bill.id)).toBe(before.billDigest);
      expect(await stored(client, billRequest)).toBe(before.bill);

      // A second run (the body now 1009's own) changes nothing.
      const ids = [pending, approved, stale, rejected, billRequest];
      const after = await Promise.all(ids.map((id) => stored(client, id)));
      await migrate(client);
      expect(await Promise.all(ids.map((id) => stored(client, id)))).toEqual(after);
      expect(await liveMd5(client)).toBe(md5(prosrcOf(BODY_1009)));
    });
  });

  it('pins the two bodies it accepts by md5(prosrc): recomputed from the repo\'s SQL and read back from Postgres', async () => {
    expect(MIGRATION).toContain(`NOT IN ('${md5(prosrcOf(BODY_923))}', '${md5(prosrcOf(BODY_1009))}')`);
    expect(await liveMd5(pool)).toBe(md5(prosrcOf(BODY_1009))); // the build applied 1009 over 923's body
    await rolledBack(async (client) => {
      await client.query(BODY_923);
      expect(await liveMd5(client)).toBe(md5(prosrcOf(BODY_923)));
    });
  });

  it.each([
    ['874\'s body', () => digestAsIn('874_customer_invoice_line_revenue_coding.sql', PRE_951)],
    ['923\'s body with one character changed', () => BODY_923.replace('SELECT CASE p_document_type', 'SELECT  CASE p_document_type')],
  ])('refuses to run over %s, changing nothing', async (_label, body) => {
    await rolledBack(async (client) => {
      await client.query(body());
      await expect(migrate(client)).rejects.toThrow(/approval_document_digest_pre_payroll_951 is neither 923's body nor 1009's/);
    });
  });

  it('refuses to run without 951\'s wrapper, or without 1008\'s columns', async () => {
    await rolledBack(async (client) => {
      await client.query('SAVEPOINT m');
      await client.query(digestAsIn('923_payment_digest_payee_name_originator.sql', 'public.approval_document_digest'));
      await expect(migrate(client)).rejects.toThrow(/apply migration 951 first/);
      await client.query('ROLLBACK TO SAVEPOINT m');
      await client.query('ALTER TABLE public.customer_invoices DROP COLUMN amounts_are');
      await expect(migrate(client)).rejects.toThrow(/apply migration 1008 first/);
    });
  });
});
