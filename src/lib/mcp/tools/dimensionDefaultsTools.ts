/**
 * MCP tools for the master-data defaults the dimension derivation reads:
 *
 *   set_gl_account_reporting_attributes — the account ladder (category,
 *     statement line/group, class, cash class, capex/opex) on up to 500 accounts;
 *   set_customer_default_fno — the FNO every revenue line of that customer takes;
 *   set_bank_account_default_dimensions — the CC/BU card spend defaults to;
 *   set_supplier_default_dimensions — the CC/BU a supplier's bill lines default to.
 *
 * None moves an amount or posts, so none is requiresPost. Each refuses from
 * reads before writing and supports dry_run.
 */
import type { McpTool, McpToolResult } from '../types';
import {
  REPORTING_ATTRIBUTES, applyBankAccountDefaults, applyCustomerDefaultFno, applyReportingAttributes,
  planBankAccountDefaults, planCustomerDefaultFno, planReportingAttributes,
  type ReportingAttributePatch, type ReportingAttributesItem,
} from '@/modules/accounting/services/gl/dimensions/dimensionDefaultsService';
import { isDimensionRefusal } from '@/modules/accounting/services/gl/dimensions/dimensionTypes';
import {
  applySupplierDefaultsPlan, planSupplierDefaults, type SupplierDefaultRefs,
} from '@/modules/accounting/services/gl/dimensions/supplierDimensionDefaults';
import { SupplierNotInCompanyError } from '@/modules/accounting/services/core/contactDirectoryService';
import { UUID_RE } from '@/lib/validation';
import { NOT_FOUND, ok, strArg, toolError } from './toolHelpers';

export const MAX_ATTRIBUTE_ITEMS = 500;

function preview(data: Record<string, unknown>): McpToolResult {
  const r = ok({ dry_run: true, ...data });
  r.wroteNothing = true;
  r.billable = false;
  return r;
}

/** Plans throw DimensionRefusal from reads; those become tool errors. Anything else propagates. */
async function refusalOr<T>(fn: () => Promise<T>): Promise<T | McpToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (isDimensionRefusal(err)) return toolError(err.message === 'Not found' ? NOT_FOUND : err.message);
    throw err;
  }
}
const isResult = (v: unknown): v is McpToolResult => typeof v === 'object' && v !== null && 'content' in v;

function parseAttributeItems(raw: unknown): ReportingAttributesItem[] | string {
  if (!Array.isArray(raw) || raw.length === 0) return 'items must be a non-empty array';
  if (raw.length > MAX_ATTRIBUTE_ITEMS) return `items holds ${raw.length} entries — at most ${MAX_ATTRIBUTE_ITEMS}`;
  const out: ReportingAttributesItem[] = [];
  for (const [i, entry] of raw.entries()) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return `items[${i}] must be an object`;
    const o = entry as Record<string, unknown>;
    const account = typeof o.account === 'string' ? o.account.trim() : '';
    if (!account) return `items[${i}].account (GL account UUID or code) is required`;
    const patch: ReportingAttributePatch = {};
    for (const key of REPORTING_ATTRIBUTES) {
      if (!(key in o)) continue;
      const v = o[key];
      if (v !== null && typeof v !== 'string') return `items[${i}].${key} must be text, or null to clear`;
      patch[key] = v === null || v.trim() === '' ? null : v.trim();
    }
    const unknown = Object.keys(o).filter((k) => k !== 'account' && !(REPORTING_ATTRIBUTES as readonly string[]).includes(k));
    if (unknown.length > 0) return `items[${i}] carries unknown field(s): ${unknown.join(', ')}`;
    if (Object.keys(patch).length === 0) return `items[${i}] sets no attribute`;
    out.push({ account, patch });
  }
  return out;
}

const ATTRIBUTE_PROPS = Object.fromEntries(REPORTING_ATTRIBUTES.map((k) => [k, { type: ['string', 'null'] }]));

export const setGlAccountReportingAttributesTool: McpTool = {
  name: 'set_gl_account_reporting_attributes',
  description:
    'Set the reporting ladder on up to 500 GL accounts: report_category (L4), statement_line (L3), statement_group '
    + '(L2), report_class (L1), cash_class and capex_opex. These are attributes of the ACCOUNT, so every line on it '
    + 'derives them and none is typed on a transaction. Send only the attributes to change; null clears one. Posts nothing.',
  scope: 'write:accounts',
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_ATTRIBUTE_ITEMS,
        items: {
          type: 'object',
          properties: { account: { type: 'string', description: 'GL account UUID or account code' }, ...ATTRIBUTE_PROPS },
          required: ['account'],
          additionalProperties: false,
        },
      },
      dry_run: { type: 'boolean' },
      idempotency_key: { type: 'string' },
    },
    required: ['items', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const items = parseAttributeItems(args.items);
    if (typeof items === 'string') return toolError(items);
    const plan = await refusalOr(() => planReportingAttributes(ctx.companyId, items));
    if (isResult(plan)) return plan;
    const summary = { accounts: plan.map((p) => ({ account_code: p.accountCode, set: p.patch })) };
    if (args.dry_run === true) return preview({ would_update: plan.length, ...summary });
    await applyReportingAttributes(ctx.companyId, plan);
    return ok({ updated: plan.length, ...summary });
  },
};

export const setCustomerDefaultFnoTool: McpTool = {
  name: 'set_customer_default_fno',
  description:
    'Set (or clear with fno: null) the FNO — a CC1 code, UUID or alias — that every revenue line of this customer '
    + 'takes. A project (CC2) under another FNO is then refused on its invoices. Posts nothing.',
  scope: 'write:contacts',
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      customer_id: { type: 'string' },
      fno: { type: ['string', 'null'], description: 'CC1 code, UUID or alias; null clears it.' },
      dry_run: { type: 'boolean' },
      idempotency_key: { type: 'string' },
    },
    required: ['customer_id', 'fno', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const customerId = strArg(args, 'customer_id');
    if (!customerId) return toolError('customer_id is required');
    if (args.fno === undefined) return toolError('fno is required (a CC1 code, UUID or alias, or null to clear)');
    if (args.fno !== null && typeof args.fno !== 'string') return toolError('fno must be text or null');
    const fno = typeof args.fno === 'string' && args.fno.trim() ? args.fno.trim() : null;
    const plan = await refusalOr(() => planCustomerDefaultFno(ctx.companyId, customerId, fno));
    if (isResult(plan)) return plan;
    const summary = { customer_id: plan.customerId, fno_id: plan.fnoId, previous_fno_id: plan.previousFnoId };
    if (args.dry_run === true) return preview(summary);
    await applyCustomerDefaultFno(ctx.companyId, plan);
    return ok(summary);
  },
};

export const setBankAccountDefaultDimensionsTool: McpTool = {
  name: 'set_bank_account_default_dimensions',
  description:
    'Set the default CC1 / CC2 / BU of a bank or paycard account (GL UUID or code, subtype bank). Card spend '
    + 'allocated to a cost account with no dimensions of its own takes these; a settlement never does. Each of '
    + 'cc1 / cc2 / bu: a code, UUID or alias to set, null to clear, omitted to keep. Posts nothing.',
  scope: 'write:accounts',
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      bank_account: { type: 'string', description: 'GL account UUID or code of the bank / card account' },
      cc1: { type: ['string', 'null'] },
      cc2: { type: ['string', 'null'] },
      bu: { type: ['string', 'null'] },
      dry_run: { type: 'boolean' },
      idempotency_key: { type: 'string' },
    },
    required: ['bank_account', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const account = strArg(args, 'bank_account');
    if (!account) return toolError('bank_account is required');
    const refs: { cc1?: string | null; cc2?: string | null; bu?: string | null } = {};
    for (const kind of ['cc1', 'cc2', 'bu'] as const) {
      const v = args[kind];
      if (v === undefined) continue;
      if (v !== null && (typeof v !== 'string' || !v.trim())) return toolError(`${kind} must be a code, UUID or alias, or null`);
      refs[kind] = v === null ? null : v.trim();
    }
    if (Object.keys(refs).length === 0) return toolError('Name at least one of cc1, cc2, bu (null clears it)');
    const plan = await refusalOr(() => planBankAccountDefaults(ctx.companyId, account, refs));
    if (isResult(plan)) return plan;
    const view = (d: typeof plan.next) => ({ cc1_id: d.cc1Id ?? null, cc2_id: d.cc2Id ?? null, bu_id: d.buId ?? null });
    const summary = { account_code: plan.accountCode, previous: view(plan.previous), next: view(plan.next) };
    if (args.dry_run === true) return preview(summary);
    await applyBankAccountDefaults(ctx.companyId, plan);
    return ok(summary);
  },
};

export const setSupplierDefaultDimensionsTool: McpTool = {
  name: 'set_supplier_default_dimensions',
  description:
    'Set the default CC1 / CC2 / BU of a supplier (migration 890). Every bill line of that supplier that names '
    + 'no CC1 or CC2 takes the default CC2 (and CC1); a line with no BU takes the default BU; a line\'s own '
    + 'dimensions always win, and posted bills are not touched. Each of cc1 / cc2 / bu: a code, UUID or alias to '
    + 'set, null to clear, omitted to keep. A default CC1 that contradicts the default CC2\'s FNO is refused. Posts nothing.',
  scope: 'write:contacts',
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      supplier_id: { type: 'string' },
      cc1: { type: ['string', 'null'] },
      cc2: { type: ['string', 'null'] },
      bu: { type: ['string', 'null'] },
      dry_run: { type: 'boolean' },
      idempotency_key: { type: 'string' },
    },
    required: ['supplier_id', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const supplierId = strArg(args, 'supplier_id');
    if (!supplierId || !UUID_RE.test(supplierId)) return toolError('supplier_id (a supplier UUID) is required');
    const refs: SupplierDefaultRefs = {};
    for (const kind of ['cc1', 'cc2', 'bu'] as const) {
      const v = args[kind];
      if (v === undefined) continue;
      if (v !== null && (typeof v !== 'string' || !v.trim())) return toolError(`${kind} must be a code, UUID or alias, or null`);
      refs[kind] = v === null ? null : v.trim();
    }
    if (Object.keys(refs).length === 0) return toolError('Name at least one of cc1, cc2, bu (null clears it)');
    let plan;
    try {
      plan = await planSupplierDefaults(ctx.companyId, supplierId, refs);
    } catch (err) {
      if (err instanceof SupplierNotInCompanyError) return toolError(NOT_FOUND);
      if (isDimensionRefusal(err)) return toolError(err.message);
      throw err;
    }
    const view = (d: typeof plan.next) => ({ cc1_id: d.cc1Id ?? null, cc2_id: d.cc2Id ?? null, bu_id: d.buId ?? null });
    const summary = { supplier_id: plan.supplierId, previous: view(plan.previous), next: view(plan.next) };
    if (args.dry_run === true) return preview(summary);
    await applySupplierDefaultsPlan(ctx.companyId, plan, UUID_RE.test(ctx.userId) ? ctx.userId : null);
    return ok(summary);
  },
};
