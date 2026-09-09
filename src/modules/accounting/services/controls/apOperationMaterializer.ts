import {assertStandalonePaymentVoid,assertStandalonePaymentProcess} from '../ap/batchPaymentValidation';
import { createHash } from 'node:crypto';
import Decimal from 'decimal.js';
import { canonicalJson, canonicalMoney } from './canonical';
import { assertControlTx } from './context';
import { resolveApReversalMaterial } from '../ap/apReversalMaterial';
import { resolveApControlAccounts } from '../ap/apControlAccounts';
import type { ControlTx, EntityRef, EntityVersionRef, OperationBinding, OperationRef } from './contracts';

type Row = Record<string, unknown>;
export function deriveInvoiceAmount(header: string, lines: readonly { line_total: string; tax_amount: string }[]): string {
  if (!lines.length) throw new Error('Invoice material is incomplete');
  const amount = lines.reduce((sum, line) => sum.add(canonicalMoney(line.line_total)).add(canonicalMoney(line.tax_amount)), new Decimal(0));
  const gross = new Decimal(canonicalMoney(header));
  const lineTotal = lines.reduce((sum, line) => sum.add(canonicalMoney(line.line_total)), new Decimal(0));
  if ((!amount.eq(gross) && !lineTotal.eq(gross)) || !gross.gt(0)) throw new Error('Invoice total does not reconcile to lines');
  return gross.toFixed();
}
export function derivePaymentAmount(header: string, allocations: readonly { amount_allocated: string; invoice_currency: string }[]) {
  const currencies = new Set(allocations.map(a => a.invoice_currency));
  if (!allocations.length || currencies.size !== 1 || !/^[A-Z]{3}$/.test(allocations[0]!.invoice_currency)) {
    throw new Error('Payment currency is missing or ambiguous');
  }
  const amount = allocations.reduce((sum, row) => {
    const allocated = new Decimal(canonicalMoney(row.amount_allocated));
    if (!allocated.gt(0)) throw new Error('Invalid payment allocation');
    return sum.add(allocated);
  }, new Decimal(0));
  if (!amount.eq(canonicalMoney(header)) || !amount.gt(0)) throw new Error('Payment total does not reconcile to allocations');
  return { amount: amount.toFixed(), currency: allocations[0]!.invoice_currency };
}

export interface ObservedSource extends EntityVersionRef { tracked: boolean; facts: Record<string, unknown> }
export interface ApMaterial {
  binding: Omit<OperationBinding, 'policies'>;
  observedSources: ObservedSource[];
  supplierId: string;
  versionBasis: 'recorded_with_current_fingerprint' | 'untracked_current_observation';
}
function hash(value: unknown): string { return createHash('sha256').update(canonicalJson(value)).digest('hex'); }
async function observe(ctx: ControlTx, ref: EntityRef, facts: Record<string, unknown>, evidenceFacts: Record<string, unknown> = facts): Promise<ObservedSource> {
  const { readControlEntityVersion } = await import('./operationVersions');
  const existing = await readControlEntityVersion(ctx, ref);
  return { entityType: ref.entityType, entityId: ref.entityId, version: existing?.version ?? 1, fingerprint: hash(facts), tracked: existing !== null, facts: evidenceFacts };
}

/** Called only after actor/policy locks; every business fact comes from owned DB rows. */
export async function materializeApOperation(ctx: ControlTx, ref: OperationRef): Promise<ApMaterial> {
  assertControlTx(ctx);
  const company = ctx.principal.companyId;
  let header: Row | undefined;
  let sourceFacts: Record<string, unknown>;
  let amount: string, currency: string, accountingDate: string;
  const observations: ObservedSource[] = [];
  if (ref.entityType === 'supplier_invoice') {
    [header] = await ctx.sql`
      SELECT id,supplier_id,invoice_date::text,subtotal::text,tax_amount::text,total_amount::text,
        currency,status,gl_journal_entry_id,purchase_order_id,grn_id,project_id,cost_center_id
      FROM supplier_invoices WHERE company_id=${company}::uuid AND id=${ref.entityId}::uuid FOR UPDATE
    ` as Row[];
    if (!header) throw new Error('Operation not found');
    const lines = await ctx.sql`
      SELECT sii.id,sii.quantity::text,sii.unit_price::text,sii.line_total::text,sii.tax_amount::text,
        sii.tax_rate::text,sii.gl_account_id,sii.po_item_id,sii.project_id,sii.cost_center_id
      FROM supplier_invoice_items sii JOIN supplier_invoices si ON si.id=sii.supplier_invoice_id
      WHERE si.company_id=${company}::uuid AND si.id=${ref.entityId}::uuid ORDER BY sii.id FOR SHARE OF sii
    ` as Array<Row & { line_total: string; tax_amount: string }>;
    amount = deriveInvoiceAmount(String(header.total_amount), lines);
    currency = String(header.currency); accountingDate = String(header.invoice_date);
    sourceFacts = { header, lines };
  } else if (ref.entityType === 'supplier_payment') {
    [header] = await ctx.sql`
      SELECT id,supplier_id,payment_date::text,total_amount::text,payment_method,bank_account_id,
        status,gl_journal_entry_id,batch_id,reference
      FROM supplier_payments WHERE company_id=${company}::uuid AND id=${ref.entityId}::uuid FOR UPDATE
    ` as Row[];
    if (!header) throw new Error('Operation not found');
    if (ref.operation === 'supplier_payment.void') assertStandalonePaymentVoid(header.batch_id);
    if (ref.operation === 'supplier_payment.process') assertStandalonePaymentProcess(header.batch_id);
    const allocations = await ctx.sql`
      SELECT pa.id,pa.invoice_id,pa.amount_allocated::text,si.currency AS invoice_currency,
        si.total_amount::text,si.amount_paid::text,si.status,si.gl_journal_entry_id
      FROM payment_allocations pa JOIN supplier_payments sp ON sp.id=pa.payment_id
      JOIN supplier_invoices si ON si.id=pa.invoice_id AND si.company_id=sp.company_id AND si.supplier_id=sp.supplier_id
      WHERE sp.company_id=${company}::uuid AND sp.id=${ref.entityId}::uuid
      ORDER BY si.id,pa.id FOR SHARE OF pa,si
    ` as Array<Row & { amount_allocated: string; invoice_currency: string }>;
    const [count] = await ctx.sql`
      SELECT count(*)::int AS count FROM payment_allocations pa JOIN supplier_payments sp ON sp.id=pa.payment_id
      WHERE sp.company_id=${company}::uuid AND sp.id=${ref.entityId}::uuid
    ` as Array<{ count: number }>;
    if (count?.count !== allocations.length) throw new Error('Payment allocation material is incomplete');
    ({ amount, currency } = derivePaymentAmount(String(header.total_amount), allocations));
    const invoiceLines = await ctx.sql`
      SELECT sii.id,sii.supplier_invoice_id,sii.quantity::text,sii.unit_price::text,sii.line_total::text,
        sii.tax_amount::text,sii.tax_rate::text,sii.gl_account_id,sii.po_item_id,sii.project_id,sii.cost_center_id
      FROM supplier_invoice_items sii JOIN supplier_invoices si ON si.id=sii.supplier_invoice_id
      JOIN payment_allocations pa ON pa.invoice_id=si.id JOIN supplier_payments sp ON sp.id=pa.payment_id
      WHERE sp.company_id=${company}::uuid AND sp.id=${ref.entityId}::uuid AND si.company_id=sp.company_id
      ORDER BY si.id,sii.id FOR SHARE OF sii
    ` as Row[];
    accountingDate = String(header.payment_date); sourceFacts = { header, allocations, invoiceLines };
    for (const allocation of allocations) observations.push(await observe(ctx,
      { entityType: 'supplier_invoice', entityId: String(allocation.invoice_id) },
      { allocation, lines: invoiceLines.filter(line => line.supplier_invoice_id === allocation.invoice_id) }));
  } else { throw new Error('Unsupported AP operation entity'); }
  const [supplier] = await ctx.sql`
    SELECT id,bank_name,bank_account_number,bank_branch_code,bank_account_type
    FROM suppliers WHERE company_id=${company}::uuid AND id=${String(header.supplier_id)}::uuid FOR SHARE
  ` as Row[];
  if (!supplier) throw new Error('Operation not found');
  const { beneficiaryFingerprint } = await import('./changeProtection');
  const bankFingerprint = beneficiaryFingerprint(company, supplier);
  const accounts = await resolveApControlAccounts(ctx, ref);
  // These writers post nominal amounts; no authoritative FX conversion exists here.
  if (currency !== accounts.ledgerCurrency) throw new Error('AP currency differs from ledger currency; a bound conversion is required');
  const reversal = await resolveApReversalMaterial(ctx, ref, header.gl_journal_entry_id, accountingDate);
  accountingDate = reversal.accountingDate;
  sourceFacts = { ...sourceFacts, accounts: accounts.facts, reversal: reversal.facts };
  const parent = await observe(ctx, ref, sourceFacts);
  const bank = await observe(ctx, { entityType: 'supplier', entityId: String(supplier.id) },
    { bankFingerprint }, { ...supplier, beneficiary_status: 'legacy_unverified' });
  observations.push(parent, bank);
  if (ref.expectedVersion !== undefined && ref.expectedVersion !== parent.version) throw new Error('Operation version changed');
  return { supplierId: String(supplier.id), observedSources: observations,
    versionBasis: observations.every(row => row.tracked) ? 'recorded_with_current_fingerprint' : 'untracked_current_observation',
    binding: { companyId: company, operation: ref.operation, entityType: ref.entityType, entityId: ref.entityId,
      entityVersion: parent.version, accountingDate, amount, currency,
      beneficiaries: [{ entityType: 'supplier', entityId: String(supplier.id), beneficiaryId: `legacy:${String(supplier.id)}`,
        version: bank.version, fingerprint: bankFingerprint, amount, currency }],
      sourceVersions: observations.map(({ tracked: _tracked, facts: _facts, ...source }) => source) } };
}
