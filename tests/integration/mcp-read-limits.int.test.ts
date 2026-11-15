/**
 * Paging and `detail: "summary"` / `group_by` for the step-7h follow-up reads, against real rows: for the same
 * filters a summary's totals equal the sum of the rows the tool pages out, its groups equal those rows grouped, a
 * paged walk serves every row exactly once, and another company's rows (SECRET) are never counted.
 *
 * Covers list_credit_notes (whose `status` filter used to be ignored), list_supplier_payments, list_documents (bank
 * store), and the in-memory pages of list_bank_rules and list_work_items over their real tie-break order.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { sql } from '@/lib/neon';
import { listCreditNotesTool } from '@/lib/mcp/tools/creditNotes';
import { listSupplierPaymentsTool } from '@/lib/mcp/tools/listSupplierPayments';
import { listDocumentsTool } from '@/lib/mcp/tools/listDocuments';
import { listBankRulesTool } from '@/lib/mcp/tools/bankRules';
import { listWorkItemsTool } from '@/lib/mcp/tools/practice';
import type { McpTool, McpToolContext } from '@/lib/mcp/types';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { dropFixture, seedBankTx, seedBill, seedFixture, seedSupplier, type Fixture } from './helpers/l1FifoFixture';
import { bankUpload, capturedDoc, dropDocuments } from './helpers/documentFixture';
import { addUp, groupMap, sum, tally, type Json } from './helpers/summaryFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('MCP read limits against real rows', () => {
  let a: Fixture;
  let b: Fixture;
  const SCOPES = ['read:invoices', 'read:reports', 'read:bank-tx', 'read:practice'];
  const ctxFor = (f: Fixture): McpToolContext => ({ userId: f.userId, companyId: f.companyId, scopes: SCOPES, tokenJti: 'j', oauthAppId: null });
  async function call(tool: McpTool, args: Record<string, unknown>, f: Fixture = a): Promise<Json> {
    const res = await tool.handler(args, ctxFor(f));
    if (res.isError) throw new Error(`${tool.name}: ${res.content[0]!.text}`);
    return JSON.parse(res.content[0]!.text) as Json;
  }
  /** Walks next_offset until null, returning every row in order. */
  async function walk(tool: McpTool, args: Record<string, unknown>, key: string, limit: number, f: Fixture = a): Promise<Json[]> {
    const out: Json[] = [];
    let offset: number | null = 0;
    for (let i = 0; i < 200 && offset !== null; i++) {
      const body: Json = await call(tool, { ...args, limit, offset }, f);
      out.push(...(body[key] as Json[]));
      offset = body.next_offset as number | null;
    }
    expect(offset).toBeNull();
    return out;
  }
  const ids = (rows: Json[], k = 'id'): string[] => rows.map((r) => String(r[k]));

  let supB: string;
  let cust2: string;
  let sup2: string;

  beforeAll(async () => {
    assertNotProductionDb('This test seeds companies, credit notes, payments, documents, rules and work items.');
    a = await seedFixture('MRLA', DATABASE_URL!);
    b = await seedFixture('MRLB', DATABASE_URL!);
    cust2 = ((await sql`INSERT INTO customers (name, company_id) VALUES (${`Second ${a.tag}`}, ${a.companyId}::UUID) RETURNING id`) as Json[])[0]!.id;
    sup2 = await seedSupplier(a, 'Second');
    supB = b.supplierId;

    // Credit notes: both types, every status, four months; B carries SECRET ones.
    const notes: Array<[Fixture, string, string, string, number, number]> = [];
    const statuses = ['draft', 'approved', 'partially_applied', 'applied', 'cancelled'];
    for (let i = 0; i < 23; i++) {
      const month = String(1 + (i % 4)).padStart(2, '0');
      notes.push([a, i % 3 === 0 ? 'supplier' : 'customer', statuses[i % 5]!, `2026-${month}-${String(10 + (i % 9)).padStart(2, '0')}`, 100 + i * 7.35, i % 2 ? 20.5 : 0]);
    }
    notes.push([b, 'customer', 'approved', '2026-02-01', 9999, 0]);
    for (const [f, type, status, date, total, applied] of notes) {
      const party = type === 'customer' ? (total > 200 ? f.customerId : cust2) : (total > 200 ? f.supplierId : sup2);
      await sql`
        INSERT INTO credit_notes (company_id, type, client_id, supplier_id, credit_date, subtotal, tax_amount, total_amount, applied_amount, status,
                                  created_by, credit_note_number, reason)
        VALUES (${f.companyId}::UUID, ${type}, ${type === 'customer' ? party : null}::UUID, ${type === 'supplier' ? party : null}::UUID,
                ${date}::DATE, ${total}, ${Math.round(total * 15) / 100}, ${total + Math.round(total * 15) / 100}, ${applied}, ${status},
                ${f.userId}::UUID, ${`CN-${randomUUID().slice(0, 8)}`}, ${f === b ? 'SECRET' : 'reason'})`;
    }

    // Supplier payments: three suppliers, statuses, months; some applied to a bill; B's SECRET.
    const bill = await seedBill(a, { number: 'MRL-B1', date: '2026-01-05', total: 5000 });
    const payments: Array<[Fixture, string, string, string, number, number]> = [];
    const pstatus = ['draft', 'approved', 'processed', 'reconciled', 'cancelled'];
    for (let i = 0; i < 21; i++) {
      const sup = [a.supplierId, sup2, a.supplierId][i % 3]!;
      payments.push([a, sup, pstatus[i % 5]!, `2026-0${1 + (i % 3)}-${String(5 + (i % 7)).padStart(2, '0')}`, 80 + i * 11.11, i % 4 === 0 ? 30.3 : 0]);
    }
    payments.push([b, supB, 'processed', '2026-02-02', 7777, 0]);
    let n = 0;
    for (const [f, sup, status, date, total, allocated] of payments) {
      const row = (await sql`
        INSERT INTO supplier_payments (company_id, supplier_id, payment_date, total_amount, status, created_by, payment_number, reference)
        VALUES (${f.companyId}::UUID, ${sup}::UUID, ${date}::DATE, ${total}, ${status}, ${f.userId}::UUID, ${`MRL-PAY-${++n}`}, ${f === b ? 'SECRET' : (n % 2 ? 'ref odd' : 'ref even')})
        RETURNING id`) as Json[];
      if (allocated > 0) {
        await sql`INSERT INTO payment_allocations (payment_id, invoice_id, amount_allocated) VALUES (${row[0]!.id}::UUID, ${bill}::UUID, ${allocated})`;
      }
    }

    // Bank-store documents: uploads and linked captured documents on lines in four months; B's SECRET.
    for (let i = 0; i < 17; i++) {
      const tx = await seedBankTx(a, { date: `2026-0${1 + (i % 4)}-1${i % 9}`, amount: -(10 + i), description: `MRL line ${i}` });
      await bankUpload(tx, `slip-${i}.png`);
      if (i % 3 === 0) await bankUpload(tx, `second-${i}.png`);
      if (i % 4 === 0) await capturedDoc(a.companyId, { matchedBankTx: tx });
    }
    const txB = await seedBankTx(b, { date: '2026-02-03', amount: -1, description: 'SECRET line' });
    await bankUpload(txB, 'SECRET.png');

    // Bank rules and work items: many share a priority / name, so the page order needs the id tie-break.
    for (let i = 0; i < 9; i++) {
      await sql`
        INSERT INTO bank_categorisation_rules (company_id, rule_name, match_pattern, priority, gl_account_id, auto_create_entry, is_active)
        VALUES (${a.companyId}::UUID, ${i < 6 ? 'Same name' : `Rule ${i}`}, ${`pat${i}`}, ${i < 6 ? 10 : i}, ${a.bankAccountId}::UUID, ${i % 2 === 0}, ${i !== 4})`;
    }
    await sql`INSERT INTO bank_categorisation_rules (company_id, rule_name, match_pattern, priority) VALUES (${b.companyId}::UUID, 'SECRET', 'x', 1)`;
    const cats: string[] = [];
    for (let c = 0; c < 4; c++) {
      cats.push(((await sql`INSERT INTO practice_job_categories (company_id, name) VALUES (${a.companyId}::UUID, ${`Cat ${c}`}) RETURNING id`) as Json[])[0]!.id);
    }
    const catB = ((await sql`INSERT INTO practice_job_categories (company_id, name) VALUES (${b.companyId}::UUID, 'CatB') RETURNING id`) as Json[])[0]!.id;
    // Four items tie on (sort_order, name), one per category, so the page order needs the id tie-break.
    for (let i = 0; i < 11; i++) {
      await sql`INSERT INTO practice_work_items (company_id, category_id, name, sort_order, is_active) VALUES (${a.companyId}::UUID, ${cats[i % 4]!}::UUID, ${i < 4 ? 'Same' : `Item ${i}`}, ${i < 4 ? 0 : i}, ${i !== 5})`;
    }
    await sql`INSERT INTO practice_work_items (company_id, category_id, name) VALUES (${b.companyId}::UUID, ${catB}::UUID, 'SECRET')`;
  }, 120_000);

  afterAll(async () => {
    for (const f of [a, b]) {
      if (!f) continue;
      await sql`DELETE FROM practice_work_items WHERE company_id = ${f.companyId}::UUID`;
      await sql`DELETE FROM practice_job_categories WHERE company_id = ${f.companyId}::UUID`;
      await sql`DELETE FROM bank_categorisation_rules WHERE company_id = ${f.companyId}::UUID`;
      await sql`DELETE FROM credit_notes WHERE company_id = ${f.companyId}::UUID`;
      await dropDocuments(f);
      await dropFixture(f);
    }
  }, 120_000);

  describe('list_credit_notes', () => {
    const FILTERS: Array<Record<string, unknown>> = [{}, { type: 'supplier' }, { type: 'customer' }, { status: 'applied' }, { type: 'supplier', status: 'draft' }];
    const measures = {
      count: () => 1, total_amount: (r: Json) => Number(r.total_amount), tax_amount: (r: Json) => Number(r.tax_amount), applied_amount: (r: Json) => Number(r.applied_amount),
    };
    const party = (r: Json): string => String(r.client_id ?? r.supplier_id);

    it('the status filter filters (it was silently ignored): every row has the status, and the count says so', async () => {
      const rows = await walk(listCreditNotesTool, { status: 'applied' }, 'credit_notes', 4);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.status === 'applied')).toBe(true);
      const total = (await call(listCreditNotesTool, { status: 'applied', limit: 1 })).total;
      expect(total).toBe(rows.length);
      const all = await walk(listCreditNotesTool, {}, 'credit_notes', 5);
      expect(all.length).toBe(23);
      expect(new Set(ids(all)).size).toBe(23);
    });

    for (const raw of FILTERS) {
      it(`totals equal the paged rows and groups equal the rows grouped, for ${JSON.stringify(raw)}`, async () => {
        const rows = await walk(listCreditNotesTool, raw, 'credit_notes', 6);
        const m = Object.keys(measures);
        const totals = (await call(listCreditNotesTool, { ...raw, detail: 'summary' })).totals;
        expect(totals).toEqual(Object.fromEntries(m.map((k) => [k, k === 'count' ? rows.length : sum(rows.map(measures[k as keyof typeof measures]))])));
        for (const [by, keyOf] of [
          ['status', (r: Json) => String(r.status)], ['type', (r: Json) => String(r.type)], ['party', party], ['month', (r: Json) => String(r.credit_date).slice(0, 7)],
        ] as const) {
          const body = await call(listCreditNotesTool, { ...raw, group_by: by });
          addUp(body, m);
          expect(groupMap(body, m)).toEqual(tally(rows, keyOf, measures));
        }
      });
    }

    it('names the party of both kinds, never counts company B, and a default call keeps its keys', async () => {
      const body = await call(listCreditNotesTool, { group_by: 'party' });
      expect((body.groups as Json[]).every((g) => g.label !== null)).toBe(true);
      expect(JSON.stringify(body)).not.toContain('SECRET');
      expect(JSON.stringify(await call(listCreditNotesTool, { limit: 50 }))).not.toContain('SECRET');
      expect(Object.keys(await call(listCreditNotesTool, { limit: 2 })).sort()).toEqual(['credit_notes', 'next_offset', 'total']);
      expect((await call(listCreditNotesTool, { detail: 'summary' }, b)).totals.count).toBe(1);
    });
  });

  describe('list_supplier_payments', () => {
    const FILTERS: Array<Record<string, unknown>> = [
      {}, { status: 'processed' }, { supplier_id: '$a' }, { from_date: '2026-02-01', to_date: '2026-03-31' }, { search: 'odd' }, { search: 'MRL-PAY-1' }, { status: 'cancelled' },
    ];
    const measures = {
      count: () => 1, payment_amount: (r: Json) => Number(r.payment_amount), allocated_amount: (r: Json) => Number(r.allocated_amount), unapplied_amount: (r: Json) => Number(r.unapplied_amount),
    };

    for (const raw of FILTERS) {
      it(`totals equal the paged rows and groups equal the rows grouped, for ${JSON.stringify(raw)}`, async () => {
        const args = raw.supplier_id ? { ...raw, supplier_id: a.supplierId } : raw;
        const rows = await walk(listSupplierPaymentsTool, args, 'payments', 5);
        expect(new Set(ids(rows, 'payment_id')).size).toBe(rows.length);
        const m = Object.keys(measures);
        const body = await call(listSupplierPaymentsTool, { ...args, detail: 'summary' });
        expect(body.totals).toEqual(Object.fromEntries(m.map((k) => [k, k === 'count' ? rows.length : sum(rows.map(measures[k as keyof typeof measures]))])));
        // The page's own `totals` block describes the same set the summary does.
        const paged = await call(listSupplierPaymentsTool, { ...args, limit: 1 });
        expect(paged.totals).toEqual({ payment_amount: body.totals.payment_amount, allocated_amount: body.totals.allocated_amount, unapplied_amount: body.totals.unapplied_amount });
        expect(paged.total).toBe(body.totals.count);
        for (const [by, keyOf] of [
          ['supplier', (r: Json) => String(r.supplier_id)], ['status', (r: Json) => String(r.status)], ['month', (r: Json) => String(r.payment_date).slice(0, 7)],
        ] as const) {
          const grouped = await call(listSupplierPaymentsTool, { ...args, group_by: by });
          addUp(grouped, m);
          expect(groupMap(grouped, m)).toEqual(tally(rows, keyOf, measures));
        }
      });
    }

    it('names suppliers, never counts company B, and a default call keeps its keys', async () => {
      const body = await call(listSupplierPaymentsTool, { group_by: 'supplier' });
      expect((body.groups as Json[]).every((g) => g.label !== null)).toBe(true);
      expect(JSON.stringify(body)).not.toContain('SECRET');
      expect(Object.keys(await call(listSupplierPaymentsTool, { limit: 2 })).sort()).toEqual(['next_offset', 'payments', 'total', 'totals']);
      expect((await call(listSupplierPaymentsTool, { detail: 'summary' }, b)).totals.count).toBe(1);
    });
  });

  describe('list_documents (bank store)', () => {
    const WINDOWS: Array<Record<string, unknown>> = [
      { from: '2026-01-01', to: '2026-12-31' }, { from: '2026-02-01', to: '2026-03-31' }, { from: '2026-01-01', to: '2026-01-31' },
    ];
    const measures = { count: () => 1, file_size: (r: Json) => Number(r.file_size) };

    for (const raw of WINDOWS) {
      it(`a paged walk serves every document once, and a summary equals it, for ${JSON.stringify(raw)}`, async () => {
        const rows = await walk(listDocumentsTool, raw, 'rows', 4);
        expect(new Set(ids(rows)).size).toBe(rows.length);
        const first = await call(listDocumentsTool, { ...raw, limit: 3 });
        expect(first.rowsTotal).toBe(rows.length);
        const m = Object.keys(measures);
        const body = await call(listDocumentsTool, { ...raw, detail: 'summary' });
        expect(body.totals.count).toBe(rows.length);
        expect(body.totals.file_size).toBe(rows.reduce((s, r) => s + Number(r.file_size), 0));
        for (const [by, keyOf] of [['store', (r: Json) => String(r.store)], ['month', (r: Json) => String(r.transaction_date).slice(0, 7)]] as const) {
          const grouped = await call(listDocumentsTool, { ...raw, group_by: by });
          addUp(grouped, m);
          expect(groupMap(grouped, m)).toEqual(tally(rows, keyOf, measures));
        }
      });
    }

    it('counts both stores, narrows to one line, never counts company B', async () => {
      const body = await call(listDocumentsTool, { from: '2026-01-01', to: '2026-12-31', group_by: 'store' });
      expect((body.groups as Json[]).map((g) => g.key).sort()).toEqual(['bank_attachment', 'captured_document']);
      expect(JSON.stringify(body)).not.toContain('SECRET');
      const rows = await walk(listDocumentsTool, { from: '2026-01-01', to: '2026-12-31' }, 'rows', 50);
      const line = String(rows[0]!.bank_transaction_id);
      const one = await call(listDocumentsTool, { from: '2026-01-01', to: '2026-12-31', bank_transaction_id: line, detail: 'summary' });
      expect(one.totals.count).toBe(rows.filter((r) => r.bank_transaction_id === line).length);
      expect(JSON.stringify(await call(listDocumentsTool, { from: '2026-01-01', to: '2026-12-31', limit: 75 }))).not.toContain('SECRET');
      expect((await call(listDocumentsTool, { from: '2026-01-01', to: '2026-12-31', detail: 'summary' }, b)).totals.count).toBe(1);
    });
  });

  describe('list_bank_rules and list_work_items page over a total order', () => {
    it('list_bank_rules: a walk of 2 serves every rule once, in priority order, and total covers the set', async () => {
      const rows = await walk(listBankRulesTool, {}, 'rules', 2);
      expect(rows).toHaveLength(9);
      expect(new Set(ids(rows)).size).toBe(9);
      const priorities = rows.map((r) => Number(r.priority));
      expect(priorities).toEqual([...priorities].sort((x, y) => x - y));
      // Six rules tie on (priority, name): the id breaks the tie, so a walk cannot skip or repeat one.
      const tied = rows.filter((r) => r.rule_name === 'Same name').map((r) => String(r.id));
      expect(tied).toHaveLength(6);
      expect(tied).toEqual([...tied].sort());
      const first = await call(listBankRulesTool, { limit: 2 });
      expect(first.total).toBe(9);
      expect(first.auto_posting_rules).toBe(4); // even i, active: 0, 2, 6, 8 (4 is inactive)
      expect(JSON.stringify(first)).not.toContain('SECRET');
      expect((await call(listBankRulesTool, { active_only: true, limit: 3 })).total).toBe(8);
    });

    it('list_work_items: a walk of 3 serves every item once, and total covers the set', async () => {
      const rows = await walk(listWorkItemsTool, {}, 'work_items', 3);
      expect(rows).toHaveLength(10); // 11 minus the inactive one
      expect(new Set(ids(rows)).size).toBe(10);
      // Four items tie on (sort_order, name): the id breaks the tie.
      const tied = rows.filter((r) => r.name === 'Same').map((r) => String(r.id));
      expect(tied).toHaveLength(4);
      expect(tied).toEqual([...tied].sort());
      expect((await call(listWorkItemsTool, { limit: 3 })).total).toBe(10);
      expect((await call(listWorkItemsTool, { include_inactive: true, limit: 3 })).total).toBe(11);
      expect(JSON.stringify(await call(listWorkItemsTool, { include_inactive: true }))).not.toContain('SECRET');
    });
  });
});
