/**
 * A supplier's default CC1 / CC2 / BU (migration 890) against a real Postgres:
 *
 *   apply on create (REST route, MCP tool) · inactive default not applied · a stale conflicting pair is
 *   refused with nothing written and no bill number consumed · set-time refusals write nothing ·
 *   delete / deactivate / move guards count a supplier default · set_supplier_default_dimensions.
 *
 * Disposable databases only — the suite skips elsewhere.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { sql } from '@/lib/neon';
import { approveSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import {
  applyUpdateDimensionCostCentre, planDeleteDimensionCostCentre, planUpdateDimensionCostCentre,
} from '@/modules/accounting/services/gl/dimensions/dimensionMasterEdit';
import { planDeleteBusinessUnit, planUpdateBusinessUnit } from '@/modules/accounting/services/core/businessUnitService';
import { setSupplierDefaultDimensionsTool } from '@/lib/mcp/tools/dimensionDefaultsTools';
import { createSupplierInvoiceTool } from '@/lib/mcp/tools/writeSupplierInvoices';
import { NOT_FOUND } from '@/lib/mcp/tools/toolHelpers';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { inTx } from './helpers/l1FifoFixture';
import { callRoute, dataOf } from './helpers/vatLateClaimRoutes';
import { legsOn } from './helpers/costCentrePickFixture';
import {
  dropSupplierDefaultsFixture, seedSupplierDefaultsFixture, type SupplierDefaultsFixture,
} from './helpers/supplierDefaultsFixture';
import supplierInvoices from '../../pages/api/accounting/supplier-invoices';
import supplierRules from '../../pages/api/accounting/supplier-rules/index';

const describeIfDb = isDisposableDb() && process.env.JWT_SECRET ? describe : describe.skip;
type Row = Record<string, unknown>;
type ToolOut = { isError?: boolean; content: { text: string }[] };
let s: SupplierDefaultsFixture;
let n = 0;

describeIfDb('supplier default dimensions (migration 890)', () => {
  beforeAll(async () => { s = await seedSupplierDefaultsFixture('SDD', process.env.DATABASE_URL!); }, 120000);
  afterAll(async () => { await dropSupplierDefaultsFixture(s); }, 120000);

  const postBill = (supplierId: string, item: Record<string, unknown> = {}) => callRoute(s.fx, s.token, supplierInvoices, {
    supplierId, invoiceNumber: `SDD-R-${++n}-${s.fx.tag}`.slice(0, 50), invoiceDate: '2026-07-10',
    items: [{ description: 'x', quantity: 1, unitPrice: 1000, taxRate: 15, glAccountId: s.fx.expenseId, ...item }],
  });
  const tool = (args: Record<string, unknown>) => inTx(s.fx, () =>
    setSupplierDefaultDimensionsTool.handler({ idempotency_key: `k-${++n}`, ...args }, s.ctx())) as Promise<ToolOut>;
  const billCount = async (supplierId: string) => Number(((await sql`
    SELECT COUNT(*) AS c FROM supplier_invoices WHERE supplier_id = ${supplierId}::UUID`) as Row[])[0]!.c);
  const sivCounter = async () => ((await sql`
    SELECT next_number FROM company_document_numbers
    WHERE company_id = ${s.fx.companyId}::UUID AND document_type = 'supplier_invoice'`) as Row[]).map((r) => Number(r.next_number));

  describe('apply on create', () => {
    it('the REST route gives an open line the default project (its FNO derived) and BU', async () => {
      const sup = await s.newSupplier();
      await s.setRule(sup, { cc2: s.PF, bu: s.BU1 });
      const res = await postBill(sup);
      expect(res.statusCode, JSON.stringify(res.body)).toBe(201);
      expect(await s.itemOf(dataOf<{ id: string }>(res).id)).toMatchObject({ cc1: s.FT, cc2: s.PF, bu: s.BU1, legacy: null });
    });

    it('a supplier with no rule is untouched, and the line\'s own CC2 and BU beat the defaults', async () => {
      const bare = await postBill(await s.newSupplier());
      expect(await s.itemOf(dataOf<{ id: string }>(bare).id)).toMatchObject({ cc1: null, cc2: null, bu: null });
      const sup = await s.newSupplier();
      await s.setRule(sup, { cc1: s.FT, cc2: s.PF, bu: s.BU1 });
      const own = await postBill(sup, { cc2Id: s.PH, buId: s.BU2 });
      expect(await s.itemOf(dataOf<{ id: string }>(own).id)).toMatchObject({ cc1: s.HT, cc2: s.PH, bu: s.BU2 });
      const fnoOnly = await postBill(sup, { cc1Id: s.HT });
      expect(await s.itemOf(dataOf<{ id: string }>(fnoOnly).id)).toMatchObject({ cc1: s.HT, cc2: null, bu: s.BU1 });
    });

    it('a legacy cost-centre pick takes no default CC, and the bill then posts without a warning', async () => {
      const sup = await s.newSupplier();
      await s.setRule(sup, { cc1: s.FT, cc2: s.PF, bu: s.BU1 });
      const line = await s.bill(sup, { costCenterId: s.HT });
      expect(await s.itemOf(line.id)).toMatchObject({ cc1: null, cc2: null, bu: s.BU1 });
      const header = await s.bill(sup, {}, { costCenterId: s.PH });
      const approved = await inTx(s.fx, () => approveSupplierInvoice(s.fx.companyId, header.id, s.fx.userId));
      const je = String(((await sql`SELECT gl_journal_entry_id FROM supplier_invoices WHERE id = ${header.id}::UUID`) as Row[])[0]!.gl_journal_entry_id);
      expect((await legsOn(s, je, s.fx.expenseId))[0]).toMatchObject({ cc1: s.HT, cc2: s.PH, legacy: null });
      expect(approved.warnings).toBeUndefined();
    });

    it('create_supplier_invoice (MCP) picks up the default too', async () => {
      const sup = await s.newSupplier();
      await s.setRule(sup, { cc2: s.PF, bu: s.BU1 });
      const out = await inTx(s.fx, () => createSupplierInvoiceTool.handler({
        supplier_id: sup, invoice_number: `SDDM-${s.fx.tag}`, invoice_date: '2026-07-10', idempotency_key: 'm1',
        lines: [{ description: 'x', quantity: 1, unit_price: 100, gl_account_id: s.fx.expenseId }],
      }, s.ctx())) as ToolOut;
      expect(out.isError).toBeFalsy();
      expect(await s.itemOf((JSON.parse(out.content[0]!.text) as { id: string }).id)).toMatchObject({ cc1: s.FT, cc2: s.PF, bu: s.BU1 });
    });

    it('an inactive default master is not applied', async () => {
      const sup = await s.newSupplier();
      await s.setRule(sup, { bu: s.BUOLD, cc1: s.INACTIVE });
      const res = await postBill(sup);
      expect(res.statusCode, JSON.stringify(res.body)).toBe(201);
      expect(await s.itemOf(dataOf<{ id: string }>(res).id)).toMatchObject({ cc1: null, cc2: null, bu: null });
    });

    it('a stale conflicting pair is a 400 that writes no bill and consumes no bill number', async () => {
      const sup = await s.newSupplier();
      await s.setRule(sup, { cc1: s.HT, cc2: s.PF }); // PF sits under FT: the pair contradicts (seeded as legacy data)
      const first = await callRoute(s.fx, s.token, supplierInvoices, {
        supplierId: sup, useSequence: true, invoiceDate: '2026-07-10',
        items: [{ description: 'x', quantity: 1, unitPrice: 10, taxRate: 15, glAccountId: s.fx.expenseId }],
      });
      expect(first.statusCode).toBe(400);
      expect(JSON.stringify(first.body)).toContain('belongs to FNO');
      expect(await billCount(sup)).toBe(0);
      const before = await sivCounter();
      const second = await callRoute(s.fx, s.token, supplierInvoices, {
        supplierId: sup, useSequence: true, invoiceDate: '2026-07-10',
        items: [{ description: 'x', quantity: 1, unitPrice: 10, taxRate: 15, glAccountId: s.fx.expenseId }],
      });
      expect(second.statusCode).toBe(400);
      expect(await sivCounter()).toEqual(before);
      // A sound supplier still reserves from the same sequence.
      const sound = await s.newSupplier();
      const ok = await callRoute(s.fx, s.token, supplierInvoices, {
        supplierId: sound, useSequence: true, invoiceDate: '2026-07-10',
        items: [{ description: 'x', quantity: 1, unitPrice: 10, taxRate: 15, glAccountId: s.fx.expenseId }],
      });
      expect(ok.statusCode, JSON.stringify(ok.body)).toBe(201);
      expect(await sivCounter()).not.toEqual(before);
    });
  });

  describe('set time (supplier-rules route and the MCP tool)', () => {
    it('forged or mis-slotted ids are 400s from the route and errors from the tool, with nothing written', async () => {
      const sup = await s.newSupplier();
      for (const body of [{ defaultCc1Id: s.FOREIGN }, { defaultBuId: s.BUX }, { defaultCc2Id: s.FT }, { defaultCc1Id: s.PF }, { defaultBuId: s.BUOLD }]) {
        const r = await callRoute(s.fx, s.token, supplierRules, { supplierId: sup, ...body });
        expect(r.statusCode, JSON.stringify(body)).toBe(400);
      }
      for (const a of [{ cc1: s.FOREIGN }, { bu: s.BUX }, { cc2: s.FT }]) {
        expect((await tool({ supplier_id: sup, ...a })).isError, JSON.stringify(a)).toBe(true);
      }
      expect(await s.ruleCount(sup)).toBe(0);
    });

    it('a conflicting CC1 + CC2 pair is a 400 with no rule row, even beside autoPublish', async () => {
      const sup = await s.newSupplier();
      const bad = await callRoute(s.fx, s.token, supplierRules, { supplierId: sup, defaultCc1Id: s.HT, defaultCc2Id: s.PF, autoPublish: true });
      expect(bad.statusCode).toBe(400);
      expect(await s.ruleCount(sup)).toBe(0);
      const good = await callRoute(s.fx, s.token, supplierRules, { supplierId: sup, defaultCc2Id: s.PF, defaultBuId: s.BU1 });
      expect(good.statusCode, JSON.stringify(good.body)).toBe(201);
    });

    it('a default project whose derived FNO is inactive is refused at set time (breaker repro 2)', async () => {
      const sup = await s.newSupplier();
      const viaRoute = await callRoute(s.fx, s.token, supplierRules, { supplierId: sup, defaultCc2Id: s.PI });
      expect(viaRoute.statusCode).toBe(400);
      expect(JSON.stringify(viaRoute.body)).toContain('active CC1');
      const viaTool = await tool({ supplier_id: sup, cc2: 'PI' });
      expect(viaTool.isError).toBe(true);
      expect(await s.ruleCount(sup)).toBe(0);
    });

    it('a held default whose master was since deactivated does not block setting another default', async () => {
      const sup = await s.newSupplier();
      await s.setRule(sup, { bu: s.BUOLD });
      const out = await tool({ supplier_id: sup, cc2: 'PF' });
      expect(out.isError, out.content[0]!.text).toBeFalsy();
    });
  });

  describe('master guards', () => {
    it('a CC1, CC2 or BU used only as a supplier default cannot be deleted or deactivated', async () => {
      await s.setRule(await s.newSupplier(), { cc1: s.D1 });
      await s.setRule(await s.newSupplier(), { cc2: s.D2, bu: s.BU3 });
      for (const ref of ['D1', 'D2']) {
        await expect(inTx(s.fx, () => planDeleteDimensionCostCentre(s.fx.companyId, ref)), `delete ${ref}`).rejects.toThrow(/1 coding rule/);
        await expect(inTx(s.fx, () => planUpdateDimensionCostCentre(s.fx.companyId, ref, { isActive: false })), `deactivate ${ref}`)
          .rejects.toThrow(/1 supplier coding rule/);
      }
      await expect(inTx(s.fx, () => planDeleteBusinessUnit(s.fx.companyId, 'B3'))).rejects.toThrow(/default/);
      await expect(inTx(s.fx, () => planUpdateBusinessUnit(s.fx.companyId, 'B3', { isActive: false }))).rejects.toThrow(/1 supplier coding rule/);
      // The database refuses a raw delete too (ON DELETE RESTRICT).
      await expect(inTx(s.fx, async () => { await sql`DELETE FROM cost_centres WHERE id = ${s.D2}::UUID`; })).rejects.toThrow();
    });

    it('a CC2 that is a supplier default cannot be moved under another FNO (breaker repro 1)', async () => {
      const sup = await s.newSupplier();
      await s.setRule(sup, { cc1: s.FT, cc2: s.PF });
      await expect(inTx(s.fx, async () => {
        const plan = await planUpdateDimensionCostCentre(s.fx.companyId, 'PF', { parent: 'HT' });
        await applyUpdateDimensionCostCentre(s.fx.companyId, plan, s.fx.userId);
      })).rejects.toThrow();
      const [row] = (await sql`SELECT parent_id::TEXT AS parent FROM cost_centres WHERE id = ${s.PF}::UUID`) as Row[];
      expect(row!.parent).toBe(s.FT);
      await s.bill(sup); // still saveable
    });
  });

  describe('set_supplier_default_dimensions', () => {
    it('refuses a non-UUID supplier_id, and a missing or foreign supplier reads as Not found', async () => {
      const bad = await tool({ supplier_id: 'not-a-uuid', cc1: 'FT' });
      expect(bad.isError).toBe(true);
      expect(bad.content[0]!.text).toContain('UUID');
      const foreign = randomUUID();
      await sql`INSERT INTO suppliers (id, company_id, name, is_active) VALUES (${foreign}::UUID, ${s.otherCompany}::UUID, 'Foreign', true)`;
      for (const id of [randomUUID(), foreign]) {
        const out = await tool({ supplier_id: id, cc1: 'FT' });
        expect(out.isError).toBe(true);
        expect(out.content[0]!.text).toBe(NOT_FOUND);
      }
      await sql`DELETE FROM suppliers WHERE id = ${foreign}::UUID`;
    });

    it('dry_run and the live call give the same refusal, and a dry run writes nothing', async () => {
      const sup = await s.newSupplier();
      const args = { supplier_id: sup, cc1: 'HT', cc2: 'PF' }; // PF is under FT
      const dry = await tool({ ...args, dry_run: true });
      const live = await tool(args);
      expect([dry.isError, live.isError]).toEqual([true, true]);
      expect(dry.content[0]!.text).toBe(live.content[0]!.text);
      const good = { supplier_id: sup, cc2: 'PF', bu: 'B1' };
      const preview = await tool({ ...good, dry_run: true });
      expect(preview.isError).toBeFalsy();
      expect(JSON.parse(preview.content[0]!.text)).toMatchObject({ dry_run: true, next: { cc1_id: null, cc2_id: s.PF, bu_id: s.BU1 } });
      expect(await s.ruleCount(sup)).toBe(0);
      expect((await tool(good)).isError).toBeFalsy();
      const [row] = (await sql`SELECT default_cc2_id::TEXT AS cc2, default_bu_id::TEXT AS bu, auto_publish
        FROM supplier_coding_rules WHERE supplier_id = ${sup}::UUID`) as Row[];
      expect(row).toMatchObject({ cc2: s.PF, bu: s.BU1, auto_publish: false });
    });

    it('null clears one default and leaves the others', async () => {
      const sup = await s.newSupplier();
      await s.setRule(sup, { cc2: s.PF, bu: s.BU1 });
      expect((await tool({ supplier_id: sup, bu: null })).isError).toBeFalsy();
      const [row] = (await sql`SELECT default_cc2_id::TEXT AS cc2, default_bu_id::TEXT AS bu
        FROM supplier_coding_rules WHERE supplier_id = ${sup}::UUID`) as Row[];
      expect(row).toMatchObject({ cc2: s.PF, bu: null });
    });
  });
});
