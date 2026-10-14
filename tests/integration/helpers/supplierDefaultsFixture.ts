/**
 * Shared seed for the supplier-default-dimensions suites (migration 890): the cost-centre pick fixture plus
 *   PF: an active project under FT · BU1, BU2: active business units · BUOLD: an inactive one ·
 *   BUX: another company's business unit.
 */
import { randomUUID } from 'crypto';
import { sql } from '@/lib/neon';
import type { McpToolContext } from '@/lib/mcp/types';
import { createSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceService';
import { inTx } from './l1FifoFixture';
import { dropPickFixture, seedPickFixture, type PickFixture } from './costCentrePickFixture';

type Row = Record<string, unknown>;

export interface SupplierDefaultsFixture extends PickFixture {
  PF: string; D1: string; D2: string; BU1: string; BU2: string; BU3: string; BUX: string; BUOLD: string;
  newSupplier: () => Promise<string>;
  setRule: (supplierId: string, cols: { cc1?: string | null; cc2?: string | null; bu?: string | null }) => Promise<unknown>;
  /** A draft bill through the service (the line fields override the defaults of one plain expense line). */
  bill: (supplierId: string, item?: Record<string, unknown>, header?: Record<string, unknown>) => ReturnType<typeof createSupplierInvoice>;
  itemOf: (billId: string) => Promise<{ cc1: string | null; cc2: string | null; bu: string | null; legacy: string | null }>;
  ruleCount: (supplierId: string) => Promise<number>;
  ctx: () => McpToolContext;
}

export async function seedSupplierDefaultsFixture(prefix: string, databaseUrl: string): Promise<SupplierDefaultsFixture> {
  const p = await seedPickFixture(prefix, databaseUrl);
  const [PF, D1, D2, BU1, BU2, BU3, BUX, BUOLD] = Array.from({ length: 8 }, () => randomUUID());
  const c = p.fx.companyId;
  await sql`INSERT INTO cost_centres (id, company_id, code, name, cc_type, parent_id, is_active)
    VALUES (${PF}::UUID, ${c}::UUID, 'PF', 'Project under FT', 'cc2', ${p.FT}::UUID, true),
           (${D1}::UUID, ${c}::UUID, 'D1', 'FNO nothing else uses', 'cc1', NULL, true),
           (${D2}::UUID, ${c}::UUID, 'D2', 'Project nothing else uses', 'cc2', ${p.FT}::UUID, true)`;
  await sql`INSERT INTO business_units (id, company_id, code, name, is_active) VALUES
    (${BU1}::UUID, ${c}::UUID, 'B1', 'BU one', true), (${BU2}::UUID, ${c}::UUID, 'B2', 'BU two', true),
    (${BU3}::UUID, ${c}::UUID, 'B3', 'BU nothing else uses', true),
    (${BUOLD}::UUID, ${c}::UUID, 'BOLD', 'BU old', false),
    (${BUX}::UUID, ${p.otherCompany}::UUID, 'BX', 'foreign', true)`;
  let n = 0;
  return {
    ...p, PF, D1, D2, BU1, BU2, BU3, BUX, BUOLD,
    newSupplier: async () => {
      const id = randomUUID();
      await sql`INSERT INTO suppliers (id, company_id, name, is_active)
        VALUES (${id}::UUID, ${c}::UUID, ${`S-${id.slice(0, 6)}`}, true)`;
      return id;
    },
    setRule: (supplierId, cols) => sql`
      INSERT INTO supplier_coding_rules (company_id, supplier_id, default_cc1_id, default_cc2_id, default_bu_id)
      VALUES (${c}::UUID, ${supplierId}::UUID, ${cols.cc1 ?? null}::UUID, ${cols.cc2 ?? null}::UUID, ${cols.bu ?? null}::UUID)
      ON CONFLICT (company_id, supplier_id) DO UPDATE SET default_cc1_id = EXCLUDED.default_cc1_id,
        default_cc2_id = EXCLUDED.default_cc2_id, default_bu_id = EXCLUDED.default_bu_id`,
    bill: (supplierId, item = {}, header = {}) => inTx(p.fx, () => createSupplierInvoice(c, {
      supplierId, invoiceNumber: `${prefix}-${++n}-${p.fx.tag}`.slice(0, 50), invoiceDate: '2026-07-10', ...header,
      items: [{ description: 'x', quantity: 1, unitPrice: 1000, taxRate: 15, glAccountId: p.fx.expenseId, ...item }],
    }, p.fx.userId)),
    itemOf: async (billId) => ((await sql`
      SELECT cc1_id::TEXT AS cc1, cc2_id::TEXT AS cc2, bu_id::TEXT AS bu, cost_center_id::TEXT AS legacy
      FROM supplier_invoice_items WHERE supplier_invoice_id = ${billId}::UUID`) as Row[])[0] as never,
    ruleCount: async (supplierId) => Number(((await sql`
      SELECT COUNT(*) AS c FROM supplier_coding_rules WHERE supplier_id = ${supplierId}::UUID`) as Row[])[0]!.c),
    ctx: () => ({ companyId: c, userId: p.fx.userId, tokenJti: `jti-${prefix}`, scopes: [] }) as unknown as McpToolContext,
  };
}

export async function dropSupplierDefaultsFixture(s: SupplierDefaultsFixture | undefined): Promise<void> {
  if (!s) return;
  const c = s.fx.companyId;
  await sql`DELETE FROM supplier_coding_rules WHERE company_id = ${c}::UUID`;
  await sql`UPDATE supplier_invoice_items SET bu_id = NULL WHERE supplier_invoice_id IN (
    SELECT id FROM supplier_invoices WHERE company_id = ${c}::UUID)`;
  await sql`UPDATE gl_journal_lines SET bu_id = NULL WHERE company_id = ${c}::UUID`;
  await sql`DELETE FROM business_units WHERE id = ANY(${[s.BU1, s.BU2, s.BU3, s.BUX, s.BUOLD]}::UUID[])`;
  await dropPickFixture(s);
}
