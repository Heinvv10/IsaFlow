/**
 * sage_party_balance — a supplier's or customer's balance, now or as at a date.
 *
 * "Now" is Sage's own Balance field. "As at" is computed, because the API has no as-at balance:
 * invoices less returns less payments/receipts dated on or before the date. Two things are NOT in
 * the computed total, because their sign or source is not verified against a live company yet:
 * adjustments (reported separately, counted: false) and opening balances. When as_at is today or
 * later, Sage's own Balance and the difference are returned beside it, so a gap is visible rather
 * than silently trusted.
 */
import type { SageClient } from './client';
import { PAGE_SIZE } from './client';
import type { SageResourceName } from './endpoints';
import { fail, ok, odataDate, type ToolResult } from './result';

const MAX_PAGES = 50;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

type Party = 'supplier' | 'customer';

const PLAN: Record<Party, { record: SageResourceName; idField: string; parts: Array<{ resource: SageResourceName; sign: 1 | -1 | 0 }> }> = {
  supplier: {
    record: 'Supplier', idField: 'SupplierId',
    parts: [
      { resource: 'SupplierInvoice', sign: 1 }, { resource: 'SupplierReturn', sign: -1 },
      { resource: 'SupplierPayment', sign: -1 }, { resource: 'SupplierAdjustment', sign: 0 },
    ],
  },
  customer: {
    record: 'Customer', idField: 'CustomerId',
    parts: [
      { resource: 'TaxInvoice', sign: 1 }, { resource: 'CustomerReturn', sign: -1 },
      { resource: 'CustomerReceipt', sign: -1 }, { resource: 'CustomerAdjustment', sign: 0 },
    ],
  },
};

const round2 = (n: number): number => Math.round(n * 100) / 100;

async function sumTotals(client: SageClient, resource: SageResourceName, filter: string): Promise<{ count: number; total: number }> {
  let count = 0;
  let total = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const p = await client.list(resource, { filter, page });
    for (const r of p.results) total += Number(r.Total ?? 0);
    count += p.results.length;
    if (p.results.length === 0 || (page + 1) * PAGE_SIZE >= p.totalResults) return { count, total: round2(total) };
  }
  throw new Error(`${resource}: more than ${MAX_PAGES * PAGE_SIZE} documents; narrow the date`);
}

async function resolveParty(client: SageClient, party: Party, args: Record<string, unknown>): Promise<Record<string, unknown> | ToolResult> {
  const { record } = PLAN[party];
  if (args.id !== undefined) return client.get(record, args.id as string | number);
  if (typeof args.name !== 'string' || !args.name.trim()) return fail('Give id or name');
  const name = args.name.trim().replace(/'/g, "''");
  const p = await client.list(record, { filter: `Name eq '${name}'` });
  if (p.results.length === 0) return fail(`No ${party} named exactly "${args.name}"`);
  if (p.results.length > 1) {
    return fail(`${p.results.length} ${party}s are named "${args.name}"; pass id. Ids: ${p.results.map((r) => r.ID).join(', ')}`);
  }
  return p.results[0]!;
}

export async function partyBalance(args: Record<string, unknown>, client: SageClient, today = new Date()): Promise<ToolResult> {
  const party = args.party;
  if (party !== 'supplier' && party !== 'customer') return fail('party must be "supplier" or "customer"');
  if (args.as_at !== undefined && (typeof args.as_at !== 'string' || !DAY.test(args.as_at))) return fail('as_at must be YYYY-MM-DD');

  const rec = await resolveParty(client, party, args);
  if ('content' in rec && Array.isArray(rec.content)) return rec as ToolResult;
  const id = (rec as Record<string, unknown>).ID;
  const head = { party, id, name: (rec as Record<string, unknown>).Name ?? null };
  const sageBalance = Number((rec as Record<string, unknown>).Balance ?? NaN);

  if (args.as_at === undefined) {
    return ok({ ...head, balance: Number.isFinite(sageBalance) ? sageBalance : null, method: 'sage_balance_field' });
  }

  const asAt = args.as_at as string;
  const plan = PLAN[party];
  const filter = `${plan.idField} eq ${Number(id)} and Date le ${odataDate(`${asAt}T23:59:59`)}`;
  const components: Array<Record<string, unknown>> = [];
  let computed = 0;
  for (const part of plan.parts) {
    const s = await sumTotals(client, part.resource, filter);
    components.push({ resource: part.resource, documents: s.count, total: s.total, counted: part.sign !== 0, sign: part.sign });
    computed += part.sign * s.total;
  }
  const todayIso = today.toISOString().slice(0, 10);
  const current = asAt >= todayIso && Number.isFinite(sageBalance);
  return ok({
    ...head,
    as_at: asAt,
    balance: round2(computed),
    method: 'computed_from_documents',
    components,
    not_counted: ['adjustments (listed above, sign unverified)', 'opening balances'],
    ...(current ? { sage_balance_field: sageBalance, difference: round2(sageBalance - computed) } : {}),
  });
}
