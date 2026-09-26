/**
 * VAT-gaps review, item 1 (HIGH breaker): "VAT declared elsewhere" could be
 * put on a document whose VAT is (or was) in the GL. Repro: mark a posted,
 * correctly-filed invoice as declared elsewhere, then reverse its journal —
 * getVatExceptions showed totalExceptions 0 and evaluateEfilingGate allowed
 * filing, though the output VAT had left the ledger.
 *
 * Fix: markVatDeclaredElsewhere/markVatDeclaredElsewhereBulk refuse a
 * document whose VAT is not currently unposted, or whose gl_journal_entry_id
 * points at a journal that is or was posted (even reversed) — BEFORE any
 * write. Read side (findUnpostedInvoiceVat/findVatDeclaredElsewhere) ignores
 * a mark for a document whose journal was reversed: it shows in the
 * BLOCKING list, never in "declared elsewhere".
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { sql } from '@/lib/neon';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { postJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostService';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import { getVatExceptions } from '@/modules/accounting/services/reports/vatExceptionsService';
import { evaluateEfilingGate } from '@/modules/accounting/services/reports/sarsEfilingSubmissionService';
import {
  markVatDeclaredElsewhere, VatDeclaredElsewhereRefusal, type VatDocKind,
} from '@/modules/accounting/services/reports/vatDeclaredElsewhereService';
import { markVatDeclaredElsewhereTool } from '@/lib/mcp/tools/vatDeclaredElsewhere';
import type { McpToolContext } from '@/lib/mcp/types';
import type { GLEntrySource, JournalLineInput } from '@/modules/accounting/types/gl.types';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { dropFixture, inTx, seedBill, seedFixture, seedInvoice, type Fixture } from './helpers/l1FifoFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
type Row = Record<string, unknown>;

let fx: Fixture;
const acct: Record<string, string> = {};
const PERIOD = { start: '2026-05-01', end: '2026-06-30' };
const report = () => inTx(fx, () => getVatExceptions(fx.companyId, PERIOD.start, PERIOD.end));

async function withVat(table: 'customer_invoices' | 'supplier_invoices', id: string): Promise<void> {
  if (table === 'customer_invoices') {
    await sql`UPDATE customer_invoices SET subtotal = 1000, tax_rate = 15, tax_amount = 150, total_amount = 1150 WHERE id = ${id}::UUID AND company_id = ${fx.companyId}::UUID`;
  } else {
    await sql`UPDATE supplier_invoices SET subtotal = 1000, tax_rate = 15, tax_amount = 150, total_amount = 1150 WHERE id = ${id}::UUID AND company_id = ${fx.companyId}::UUID`;
  }
}

async function post(source: GLEntrySource, lines: JournalLineInput[]): Promise<string> {
  return inTx(fx, async () => {
    const je = await createJournalEntry(fx.companyId, { entryDate: '2026-05-10', description: source, source, lines }, fx.userId);
    await postJournalEntry(fx.companyId, je.id, fx.userId);
    return je.id;
  });
}

async function postAndLink(kind: VatDocKind, docId: string): Promise<string> {
  const jeId = kind === 'customer'
    ? await post('auto_invoice', [
        { glAccountId: acct.receivable!, debit: 1150, credit: 0, description: 'AR' },
        { glAccountId: acct.sales!, debit: 0, credit: 1000, description: 'sale', vatType: 'standard' },
        { glAccountId: acct.vat_output!, debit: 0, credit: 150, description: 'VAT', vatType: 'standard' },
      ])
    : await post('auto_supplier_invoice', [
        { glAccountId: acct.default_expense!, debit: 1000, credit: 0, description: 'cost' },
        { glAccountId: acct.vat_input!, debit: 150, credit: 0, description: 'VAT', vatType: 'standard' },
        { glAccountId: acct.payable!, debit: 0, credit: 1150, description: 'AP' },
      ]);
  const table = kind === 'customer' ? 'customer_invoices' : 'supplier_invoices';
  await sql`UPDATE ${sql.unsafe(table)} SET gl_journal_entry_id = ${jeId}::UUID WHERE id = ${docId}::UUID AND company_id = ${fx.companyId}::UUID`;
  return jeId;
}

describeIfDb('VAT-gaps breaker fix: mark-declared-elsewhere GL guard', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test seeds invoices/bills, posts and reverses journals.');
    fx = await seedFixture('VDEGL', DATABASE_URL!);
    await sql`INSERT INTO users (id, email, role, is_active) VALUES (${fx.userId}, ${`vdegl-${fx.userId}@isaflow.test`}, 'admin', true)`;
    // getCompanyRoleForUser (the MCP tool's fresh role read) needs this row —
    // without it the tool would refuse on role alone, masking whether the
    // eligibility guard itself is what refused.
    await sql`INSERT INTO company_users (company_id, user_id, role) VALUES (${fx.companyId}::UUID, ${fx.userId}, 'owner')`;
    for (const sub of ['receivable', 'payable', 'default_expense', 'vat_input', 'vat_output']) {
      acct[sub] = String(((await sql`SELECT id FROM gl_accounts WHERE company_id = ${fx.companyId}::UUID AND account_subtype = ${sub} LIMIT 1`) as Row[])[0]!.id);
    }
    acct.sales = String(((await sql`
      INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active)
      VALUES (${fx.companyId}::UUID, '4000', ${`Sales ${fx.tag}`}, 'revenue', 'sales', 'credit', true) RETURNING id`) as Row[])[0]!.id);
  }, 180000);

  afterAll(async () => {
    if (fx) {
      await sql`DELETE FROM audit_log WHERE company_id = ${fx.companyId}::UUID`;
      await sql`DELETE FROM company_users WHERE company_id = ${fx.companyId}::UUID`;
      await sql`DELETE FROM users WHERE id = ${fx.userId}`;
      await dropFixture(fx);
    }
  }, 120000);

  for (const kind of ['customer', 'supplier'] as const) {
    describe(`${kind} document`, () => {
      it('refuses to mark a POSTED, unreversed document — VAT already in the GL', async () => {
        const docId = kind === 'customer'
          ? await seedInvoice(fx, { number: `INV-POSTED-${kind}`, date: '2026-05-05', total: 1150, status: 'sent' })
          : await seedBill(fx, { number: `BILL-POSTED-${kind}`, date: '2026-05-05', total: 1150, status: 'approved' });
        const table = kind === 'customer' ? 'customer_invoices' : 'supplier_invoices';
        await withVat(table, docId);
        await postAndLink(kind, docId);

        await expect(inTx(fx, () => markVatDeclaredElsewhere(
          fx.companyId, kind, docId, { userId: fx.userId, role: 'owner' }, 'Historical import',
        ))).rejects.toBeInstanceOf(VatDeclaredElsewhereRefusal);

        const row = ((await sql`SELECT vat_declared_elsewhere_at FROM ${sql.unsafe(table)} WHERE id = ${docId}::UUID`) as Row[])[0]!;
        expect(row.vat_declared_elsewhere_at).toBeNull();
      });

      it('the MCP mark_vat_declared_elsewhere tool returns the refusal code for a posted document', async () => {
        const docId = kind === 'customer'
          ? await seedInvoice(fx, { number: `INV-MCP-${kind}`, date: '2026-05-05', total: 1150, status: 'sent' })
          : await seedBill(fx, { number: `BILL-MCP-${kind}`, date: '2026-05-05', total: 1150, status: 'approved' });
        const table = kind === 'customer' ? 'customer_invoices' : 'supplier_invoices';
        await withVat(table, docId);
        await postAndLink(kind, docId);

        const ctx: McpToolContext = { userId: fx.userId, companyId: fx.companyId, scopes: ['read:vat', 'write:vat'], tokenJti: 'tok-1', oauthAppId: null };
        const result = await inTx(fx, () => markVatDeclaredElsewhereTool.handler({
          action: 'mark', kind, invoice_ids: [docId], reason: 'Historical import', idempotency_key: randomUUID(),
        }, ctx));
        expect(result.isError).toBe(true);
      });

      it('the BREAKER scenario: mark an unposted document, post it, then reverse its journal — it BLOCKS, never hides', async () => {
        const docId = kind === 'customer'
          ? await seedInvoice(fx, { number: `INV-BREAK-${kind}`, date: '2026-05-05', total: 1150, status: 'sent' })
          : await seedBill(fx, { number: `BILL-BREAK-${kind}`, date: '2026-05-05', total: 1150, status: 'approved' });
        const table = kind === 'customer' ? 'customer_invoices' : 'supplier_invoices';
        await withVat(table, docId);

        // 1. Mark while genuinely unposted — allowed.
        await inTx(fx, () => markVatDeclaredElsewhere(fx.companyId, kind, docId, { userId: fx.userId, role: 'owner' }, 'Historical import'));
        let r = await report();
        expect(r.declaredElsewhereVat.map((d) => d.invoiceId)).toContain(docId);
        expect(r.unpostedInvoiceVat.map((u) => u.invoiceId)).not.toContain(docId);

        // 2. Post it correctly, then reverse it (e.g. a correction).
        const jeId = await postAndLink(kind, docId);
        await inTx(fx, () => reverseJournalEntry(fx.companyId, jeId, fx.userId));

        // 3. It must now BLOCK — read side ignores the (now stale) mark —
        // and must NOT sit hidden in the declared-elsewhere list, and
        // eFiling must not be allowed.
        r = await report();
        expect(r.unpostedInvoiceVat.map((u) => u.invoiceId)).toContain(docId);
        expect(r.declaredElsewhereVat.map((d) => d.invoiceId)).not.toContain(docId);
        expect(r.totalExceptions).toBeGreaterThan(0);
        expect(evaluateEfilingGate(r).allowed).toBe(false);
      });
    });
  }
});
