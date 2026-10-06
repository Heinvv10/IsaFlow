/**
 * R-035 PR4: the database backstop on customer_invoices (migration 865,
 * trg_customer_invoice_approval_gate), and the amount a customer-invoice rule
 * sees.
 *
 * With enforcement on for customer invoices and a rule matching one, an
 * invoice may not ENTER the AR population — be inserted as, or move from
 * draft / pending_approval / cancelled to, any other status — as app_user or
 * as the owner role a script runs as, without an APPROVED request for its
 * CURRENT content, decided since enforcement was switched on, at a rank the
 * strictest rule matching today demands. Draft → cancelled always passes; the
 * import GUC exempts (customer invoices have importers, Q1).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { createUser, plantRule } from './r035-approval.helpers';
import {
  asAppUser, cleanupPr4, enforceInvoices, invoiceCompany, plantInvoice, type Invoice,
} from './r035-pr4.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let owner = '';
let other = '';

beforeAll(async () => {
  owner = await createUser(pool, tokens);
  other = await createUser(pool, tokens);
});
afterAll(() => cleanupPr4(pool, companies, [owner, other]));

async function gated(opts: { enforced?: boolean; rule?: string } = {}): Promise<{ c: string; inv: Invoice }> {
  const c = await invoiceCompany(pool, [[owner, 'owner'], [other, 'owner']], companies);
  await plantRule(pool, c, opts.rule ?? 'owner', { documentType: 'customer_invoice' });
  if (opts.enforced !== false) await enforceInvoices(pool, c, owner);
  return { c, inv: await plantInvoice(pool, c, owner) };
}

const setStatus = (client: PoolClient | Pool, id: string, status = 'approved') =>
  client.query('UPDATE customer_invoices SET status = $2 WHERE id = $1', [id, status]);
const statusOf = async (id: string) =>
  (await pool.query('SELECT status FROM customer_invoices WHERE id = $1', [id])).rows[0]?.status as string;

/** An approved request planted by the owner role (the INSERT guard binds app_user only). */
async function approvedRequest(c: string, id: string, opts: {
  digest?: 'current' | 'other'; role?: string | null; decidedAt?: string; type?: string;
} = {}): Promise<void> {
  await pool.query(
    `INSERT INTO approval_requests(company_id, document_type, document_id, status, requested_by, required_role,
       decided_by, decided_at, document_digest)
     VALUES($1,$6,$2,'approved',$3,$5,$4, COALESCE($7::TIMESTAMPTZ, now()),
            CASE $8 WHEN 'current' THEN approval_document_digest($1,'customer_invoice',$2) ELSE md5('x') END)`,
    [c, id, other, owner, opts.role === undefined ? 'owner' : opts.role, opts.type ?? 'customer_invoice',
      opts.decidedAt ?? null, opts.digest ?? 'current']);
}

describe('the customer invoice backstop', () => {
  it("raw UPDATE to 'approved' as app_user raises, and the invoice stays a draft", async () => {
    const { c, inv } = await gated();
    await expect(asAppUser(pool, owner, c, (client) => setStatus(client, inv.id))).rejects.toThrow(/R035_APPROVAL_REQUIRED/);
    expect(await statusOf(inv.id)).toBe('draft');
  });

  it('the owner role (an offline script) is held to it, for every status in the AR population', async () => {
    const { inv } = await gated();
    for (const status of ['approved', 'sent', 'paid', 'partially_paid', 'overdue']) {
      await expect(setStatus(pool, inv.id, status), status).rejects.toThrow(/R035_APPROVAL_REQUIRED/);
    }
  });

  it('pending_approval, and a cancelled invoice revived, are judged the same way', async () => {
    const { inv } = await gated();
    await setStatus(pool, inv.id, 'pending_approval');
    await expect(setStatus(pool, inv.id)).rejects.toThrow(/R035_APPROVAL_REQUIRED/);
    await setStatus(pool, inv.id, 'cancelled');
    await expect(setStatus(pool, inv.id, 'sent')).rejects.toThrow(/R035_APPROVAL_REQUIRED/);
  });

  it("raw INSERT straight into the population raises, as app_user and as the owner role", async () => {
    const { c, inv } = await gated();
    const insert = (client: PoolClient | Pool, status: string) => client.query(
      `INSERT INTO customer_invoices(company_id,invoice_number,customer_id,client_id,subtotal,tax_amount,total_amount,status,created_by)
       VALUES($1,$2,$3,$3,100,15,115,$4,$5)`, [c, `RAW-${crypto.randomUUID().slice(0, 8)}`, inv.customerId, status, owner]);
    await expect(asAppUser(pool, owner, c, (client) => insert(client, 'approved'))).rejects.toThrow(/R035_APPROVAL_REQUIRED/);
    await expect(insert(pool, 'paid')).rejects.toThrow(/R035_APPROVAL_REQUIRED/);
    await insert(pool, 'draft');
  });

  it('a soft-deleted invoice entering the population is refused even with an approval', async () => {
    const { c, inv } = await gated();
    await approvedRequest(c, inv.id);
    await pool.query('UPDATE customer_invoices SET deleted_at = now() WHERE id = $1', [inv.id]);
    await expect(setStatus(pool, inv.id)).rejects.toThrow(/R035_APPROVAL_REQUIRED/);
  });

  it('an approval for different content, or under another type, does not clear it', async () => {
    const { c, inv } = await gated();
    await approvedRequest(c, inv.id, { digest: 'other' });
    await approvedRequest(c, inv.id, { type: 'supplier_invoice' });
    await expect(setStatus(pool, inv.id)).rejects.toThrow(/R035_APPROVAL_REQUIRED/);
  });

  it('changing the content in the same UPDATE as the status is judged on the NEW content', async () => {
    const { c, inv } = await gated();
    await approvedRequest(c, inv.id);
    await expect(pool.query(
      "UPDATE customer_invoices SET status = 'approved', total_amount = 9999 WHERE id = $1", [inv.id]))
      .rejects.toThrow(/R035_APPROVAL_REQUIRED/);
  });

  it('an approval decided before enforcement was switched on clears nothing', async () => {
    const { c, inv } = await gated();
    await approvedRequest(c, inv.id, { decidedAt: '2020-01-01T00:00:00Z' });
    await expect(setStatus(pool, inv.id)).rejects.toThrow(/R035_APPROVAL_REQUIRED/);
  });

  it('applies the rank ratchet: a manager approval does not clear under an owner rule; a role-less row clears nothing', async () => {
    const { c, inv } = await gated();
    await approvedRequest(c, inv.id, { role: 'manager' });
    await approvedRequest(c, inv.id, { role: null });
    await expect(setStatus(pool, inv.id)).rejects.toThrow(/R035_APPROVAL_REQUIRED/);
    await approvedRequest(c, inv.id, { role: 'owner' });
    await setStatus(pool, inv.id);
    expect(await statusOf(inv.id)).toBe('approved');
  });

  it("another company's approval, or another company's enforcement, decides nothing here", async () => {
    const { c, inv } = await gated();
    const foreign = await invoiceCompany(pool, [[owner, 'owner']], companies);
    await pool.query(
      `INSERT INTO approval_requests(company_id, document_type, document_id, status, requested_by, required_role,
         decided_by, decided_at, document_digest)
       VALUES($1,'customer_invoice',$2,'approved',$3,'owner',$4, now(), approval_document_digest($5,'customer_invoice',$2))`,
      [foreign, inv.id, other, owner, c]);
    await expect(setStatus(pool, inv.id)).rejects.toThrow(/R035_APPROVAL_REQUIRED/);

    const free = await gated({ enforced: false });
    await enforceInvoices(pool, foreign, owner);
    await plantRule(pool, foreign, 'owner', { documentType: 'customer_invoice' });
    await setStatus(pool, free.inv.id);
    expect(await statusOf(free.inv.id)).toBe('approved');
  });

  it('lets through: a cleared approval; draft → cancelled; enforcement off; no matching rule', async () => {
    const cleared = await gated();
    await approvedRequest(cleared.c, cleared.inv.id);
    await setStatus(pool, cleared.inv.id);
    expect(await statusOf(cleared.inv.id)).toBe('approved');

    const cancelled = await gated();
    await setStatus(pool, cancelled.inv.id, 'cancelled');
    expect(await statusOf(cancelled.inv.id)).toBe('cancelled');

    const off = await gated({ enforced: false });
    await setStatus(pool, off.inv.id);
    expect(await statusOf(off.inv.id)).toBe('approved');

    const c = await invoiceCompany(pool, [[owner, 'owner']], companies);
    await plantRule(pool, c, 'owner', { documentType: 'customer_invoice', operator: 'greater_than', value: 50000 });
    await enforceInvoices(pool, c, owner);
    const small = await plantInvoice(pool, c, owner);
    await setStatus(pool, small.id);
    expect(await statusOf(small.id)).toBe('approved');
  });

  it('the import GUC exempts the write it wraps (Q1), and only while it is set', async () => {
    const { c, inv } = await gated();
    await asAppUser(pool, owner, c, async (client) => {
      await client.query("SELECT set_config('isaflow.approval_gate_exempt', 'import', true)");
      await setStatus(client, inv.id);
    });
    expect(await statusOf(inv.id)).toBe('approved');
    const next = await plantInvoice(pool, c, owner);
    await expect(asAppUser(pool, owner, c, async (client) => {
      await client.query("SELECT set_config('isaflow.approval_gate_exempt', '', true)");
      await setStatus(client, next.id);
    })).rejects.toThrow(/R035_APPROVAL_REQUIRED/);
  });
});

describe('the amount a customer-invoice rule sees (approval_customer_invoice_gate_amount)', () => {
  const amount = async (total: number | null, functional: number | null) => Number((await pool.query(
    'SELECT approval_customer_invoice_gate_amount($1, $2) AS a', [total, functional])).rows[0].a);

  it('is the larger of the total (which is what posts) and the functional figure, each absolute', async () => {
    expect(await amount(1150, null)).toBe(1150);
    expect(await amount(5000, 92500)).toBe(92500);
    expect(await amount(500000, 50)).toBe(500000);
    expect(await amount(-5000, 100)).toBe(5000);
    expect(await amount(null, null)).toBe(0);
  });

  it('the backstop matches a USD invoice on its rand value, and a tiny rate cannot shrink a large total', async () => {
    const c = await invoiceCompany(pool, [[owner, 'owner']], companies);
    await plantRule(pool, c, 'owner', { documentType: 'customer_invoice', operator: 'greater_than', value: 50000 });
    await enforceInvoices(pool, c, owner);
    const usd = await plantInvoice(pool, c, owner, { subtotal: 4347.83, tax: 652.17, total: 5000, functionalTotal: 92500, currencyCode: 'USD', exchangeRate: 18.5 });
    await expect(setStatus(pool, usd.id)).rejects.toThrow(/R035_APPROVAL_REQUIRED/);
    const shrunk = await plantInvoice(pool, c, owner, { subtotal: 434782.61, tax: 65217.39, total: 500000, functionalTotal: 50, exchangeRate: 0.0001 });
    await expect(setStatus(pool, shrunk.id)).rejects.toThrow(/R035_APPROVAL_REQUIRED/);
    const small = await plantInvoice(pool, c, owner, { functionalTotal: 1150 });
    await setStatus(pool, small.id);
    expect(await statusOf(small.id)).toBe('approved');
  });
});
