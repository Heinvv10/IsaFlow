/**
 * Two checks that read a supplier's default dimensions (migration 890) from outside the bill service:
 *
 *   - the MCP cost-of-sales project check (create_supplier_invoice, bulk_create_supplier_invoices) sees the
 *     lines AS the default project will leave them, so a defaulted line is neither refused nor warned about;
 *   - recordCoding never auto-publishes a dimensions-only rule (no default GL account).
 *
 * Disposable databases only — the suite skips elsewhere.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { recordCoding } from '@/modules/accounting/services/capture/supplierRulesService';
import { createSupplierInvoiceTool } from '@/lib/mcp/tools/writeSupplierInvoices';
import { bulkCreateSupplierInvoicesTool } from '@/lib/mcp/tools/writeBulkInvoices';
import { setSupplierDefaultDimensionsTool } from '@/lib/mcp/tools/dimensionDefaultsTools';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { inTx } from './helpers/l1FifoFixture';
import {
  dropSupplierDefaultsFixture, seedSupplierDefaultsFixture, type SupplierDefaultsFixture,
} from './helpers/supplierDefaultsFixture';

const describeIfDb = isDisposableDb() && process.env.JWT_SECRET ? describe : describe.skip;
type Row = Record<string, unknown>;
type ToolOut = { isError?: boolean; content: { text: string }[] };
let s: SupplierDefaultsFixture;
let cosId: string;
let n = 0;

describeIfDb('supplier default dimensions: the COS check and rule promotion', () => {
  beforeAll(async () => {
    s = await seedSupplierDefaultsFixture('SDC', process.env.DATABASE_URL!);
    cosId = String(((await sql`
      INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active)
      VALUES (${s.fx.companyId}::UUID, '5000', ${`Cost of sales ${s.fx.tag}`}, 'expense', 'cost_of_sales', 'debit', true)
      RETURNING id`) as Row[])[0]!.id);
  }, 120000);
  afterAll(async () => { await dropSupplierDefaultsFixture(s); }, 120000);

  const requireProject = (on: boolean) => sql`
    UPDATE companies SET require_project_on_cos = ${on} WHERE id = ${s.fx.companyId}::UUID`;
  const cosLine = { description: 'Materials', quantity: 1, unit_price: 100, gl_account_id: '' };
  const create = (supplierId: string) => inTx(s.fx, () => createSupplierInvoiceTool.handler({
    supplier_id: supplierId, invoice_number: `SDC-${++n}-${s.fx.tag}`.slice(0, 50), invoice_date: '2026-07-10',
    idempotency_key: `k-${n}`, lines: [{ ...cosLine, gl_account_id: cosId }],
  }, s.ctx())) as Promise<ToolOut>;
  const bulk = (supplierId: string) => inTx(s.fx, () => bulkCreateSupplierInvoicesTool.handler({
    idempotency_key: `kb-${++n}`,
    invoices: [{ supplier_id: supplierId, invoice_number: `SDCB-${n}-${s.fx.tag}`.slice(0, 50), invoice_date: '2026-07-10',
      lines: [{ ...cosLine, gl_account_id: cosId }] }],
  }, s.ctx())) as Promise<ToolOut>;
  const json = (out: ToolOut) => JSON.parse(out.content[0]!.text) as Record<string, unknown>;

  describe('cost-of-sales project check', () => {
    it('create_supplier_invoice: a company that requires a project accepts the line the default project fills', async () => {
      await requireProject(true);
      const withDefault = await s.newSupplier();
      await s.setRule(withDefault, { cc2: s.PF });
      const out = await create(withDefault);
      expect(out.isError, out.content[0]!.text).toBeFalsy();
      expect(json(out).dimension_warnings).toBeUndefined();
      expect(await s.itemOf(String(json(out).id))).toMatchObject({ cc1: s.FT, cc2: s.PF });
      // Control: with no default the same line is still refused.
      const refused = await create(await s.newSupplier());
      expect(refused.isError).toBe(true);
      expect(refused.content[0]!.text).toContain('cost-of-sales');
    });

    it('create_supplier_invoice: a company that only warns reports nothing for a defaulted line, and still warns without one', async () => {
      await requireProject(false);
      const withDefault = await s.newSupplier();
      await s.setRule(withDefault, { cc2: s.PF });
      expect(json(await create(withDefault)).dimension_warnings).toBeUndefined();
      expect(json(await create(await s.newSupplier())).dimension_warnings).toHaveLength(1);
    });

    it('create_supplier_invoice: a CC1-only default does not satisfy the project rule', async () => {
      await requireProject(true);
      const overhead = await s.newSupplier();
      await s.setRule(overhead, { cc1: s.FT });
      expect((await create(overhead)).isError).toBe(true);
    });

    it('bulk_create_supplier_invoices: the same, per element', async () => {
      await requireProject(true);
      const withDefault = await s.newSupplier();
      await s.setRule(withDefault, { cc2: s.PF });
      const out = await bulk(withDefault);
      expect(out.isError, out.content[0]!.text).toBeFalsy();
      const created = json(out) as { invoices: { id: string }[]; dimension_warnings?: string[] };
      expect(created.dimension_warnings).toBeUndefined();
      expect(await s.itemOf(created.invoices[0]!.id)).toMatchObject({ cc1: s.FT, cc2: s.PF });
      const refused = await bulk(await s.newSupplier());
      expect(refused.isError).toBe(true);
      expect(refused.content[0]!.text).toContain('cost-of-sales');
    });
  });

  describe('recordCoding on a dimensions-only rule', () => {
    const post = (supplierId: string, glAccountId: string | null) => recordCoding(s.fx.companyId, {
      supplierId, supplierInvoiceId: null, glAccountId, vatCode: null, costCentreId: null, projectId: null, postedBy: 'human:sdc',
    });
    const autoPublish = async (supplierId: string) => ((await sql`
      SELECT auto_publish FROM supplier_coding_rules WHERE supplier_id = ${supplierId}::UUID`) as Row[])[0]!.auto_publish;

    it('a rule the set_supplier_default_dimensions tool created never auto-publishes, however many bills post', async () => {
      const sup = await s.newSupplier();
      const out = await inTx(s.fx, () => setSupplierDefaultDimensionsTool.handler({
        supplier_id: sup, cc2: 'PF', idempotency_key: 'k-promo',
      }, s.ctx())) as ToolOut;
      expect(out.isError).toBeFalsy();
      let last = { promoted: false, sampleCount: 0 };
      for (let i = 0; i < 7; i++) last = await post(sup, null);
      expect(last.promoted).toBe(false);
      expect(await autoPublish(sup)).toBe(false);
    });

    it('control: a rule that has a default GL account still promotes at the fifth consistent posting', async () => {
      const sup = await s.newSupplier();
      for (let i = 0; i < 5; i++) await post(sup, s.fx.expenseId);
      expect(await autoPublish(sup)).toBe(true);
    });
  });
});
