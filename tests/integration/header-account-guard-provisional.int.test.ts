/**
 * A bank-first provisional whose settled line sits on an account that is NOW a header (gl/headerAccountGuard).
 *
 * `ap/provisionalInvoiceSettlement` reclasses the provisional's non-bank lines to the invoice's AP account when the
 * bill is approved or posted. Those carried lines mirror lines already posted, so a header they now sit on must not
 * strand the settlement: the reclass names them in `contraAccountIds`. Its AP leg is NEW and is still judged.
 * The provisional is coded to a prepayments-style asset account that the invoice itself never posts to, so the
 * invoice's own journal is not what is under test. Disposable databases only (r127 fixture).
 */
import { describe, expect, it } from 'vitest';
import { approveSupplierInvoice, postSupplierInvoiceToGL } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { claimEvidencedProvisional, settleInvoiceFromProvisional } from '@/modules/accounting/services/ap/provisionalInvoiceSettlement';
import { mapInvoiceRow } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowRow';
import { assertNoHeaderAccountLines, HeaderAccountRefusal } from '@/modules/accounting/services/gl/headerAccountGuard';
import {
  bankGl, company, inTx, invoiceState, payableGl, pool, seedDoc, seedInvoice, seedProvisional, supplier, useR127Fixture,
  user, vatGl,
} from './r127-double-booking.helpers';

useR127Fixture();

const TOTAL = 115;
let seq = 0;

async function account(code: string, type: 'asset' | 'liability', level: number, parent: string | null = null): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,is_active,level,parent_account_id)
     VALUES($1,$2,$3,$4,$5,$6,true,$7,$8)`,
    [id, company, code, `${code} name`, type, type === 'asset' ? 'debit' : 'credit', level, parent]);
  return id;
}

/** A header: level 1 with a child. */
async function header(code: string, type: 'asset' | 'liability'): Promise<string> {
  const id = await account(code, type, 1);
  await account(`${code}.1`, type, 2, id);
  return id;
}

/** An evidenced provisional coded to a level-1 asset account that then gains a child, and the bill raised from its slip. */
async function seedHeaderProvisional(status: 'draft' | 'approved') {
  const prepaid = await account(`HGP-${++seq}`, 'asset', 1);
  const doc = await seedDoc();
  const prov = await seedProvisional({
    totalAmount: TOTAL, supplierId: supplier, evidencedBy: doc, accounts: { bank: bankGl, expense: prepaid, vat: vatGl },
  });
  const invoiceId = await seedInvoice({ documentId: doc, totalAmount: TOTAL, status });
  await account(`HGP-${seq}.1`, 'asset', 2, prepaid);
  await expect(assertNoHeaderAccountLines(company, [{ glAccountId: prepaid }])).rejects.toBeInstanceOf(HeaderAccountRefusal);
  return { prepaid, invoiceId, ...prov };
}

const net = async (glAccountId: string): Promise<number> => Math.round(Number((await pool.query(
  `SELECT COALESCE(SUM(l.debit - l.credit),0)::float AS n FROM gl_journal_lines l
     JOIN gl_journal_entries je ON je.id = l.journal_entry_id
    WHERE je.company_id = $1 AND l.gl_account_id = $2 AND je.status = 'posted' AND je.reversed_at IS NULL`,
  [company, glAccountId])).rows[0].n) * 100) / 100;

describe('a provisional settled onto a bill after its account became a header', () => {
  it('approving the bill still settles: the carried line is reclassed off the header, AP nets to nil', async () => {
    const s = await seedHeaderProvisional('draft');
    await inTx(() => approveSupplierInvoice(company, s.invoiceId, user));
    expect(await invoiceState(s.invoiceId)).toMatchObject({ status: 'paid', paid: TOTAL });
    expect(await net(s.prepaid)).toBe(0);
    expect(await net(payableGl)).toBe(0);
  }, 60000);

  it('posting an approved bill to the GL still settles', async () => {
    const s = await seedHeaderProvisional('approved');
    const posted = await inTx(() => postSupplierInvoiceToGL(company, s.invoiceId, user));
    expect(posted.alreadyPosted).toBe(false);
    expect(await invoiceState(s.invoiceId)).toMatchObject({ paid: TOTAL });
    expect(await net(s.prepaid)).toBe(0);
  }, 60000);

  it('the reclass\'s AP leg is still judged: an AP account that is a header is refused, and nothing is settled', async () => {
    const s = await seedHeaderProvisional('draft');
    const apHeader = await header(`HGAP-${seq}`, 'liability');
    const err = await inTx(async () => {
      const claim = await claimEvidencedProvisional(company, s.invoiceId, user);
      const row = (await pool.query('SELECT * FROM supplier_invoices WHERE id = $1', [s.invoiceId])).rows[0];
      return settleInvoiceFromProvisional(company, { invoice: mapInvoiceRow(row), apAccountId: apHeader, claim: claim!, userId: user });
    }).then(() => null, (e: unknown) => e);
    expect(err, 'the AP leg was not refused').toBeInstanceOf(HeaderAccountRefusal);
    expect((err as HeaderAccountRefusal).lineIndex).toBe(0);
    expect((err as HeaderAccountRefusal).message).toContain(`Line 1: HGAP-${seq} `);
    expect(await net(apHeader)).toBe(0);
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM supplier_payments WHERE company_id = $1 AND settles_provisional_je_id = $2',
      [company, s.je])).rows[0].n).toBe(0);
  }, 60000);
});
