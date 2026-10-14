/**
 * MCP write tool: split ONE bank transaction across several lines — GL accounts,
 * each with its own VAT code and CC1 / CC2 / BU, and/or SUPPLIERS / CUSTOMERS.
 *
 * The same service the bank screen's split modal calls (splitAllocateTransaction),
 * so the journal is identical: one cost/revenue line per GL split line (plus its VAT
 * line when vat_code is standard), one AP/AR control line per contact line, and one
 * bank line. Dimensions ride on the cost/revenue lines only — never the bank, VAT or
 * control line (brief §5.3).
 *
 * A contact line (supplier_id / customer_id) SETTLES: it gets its own payment,
 * receipt or refund document on the split's journal (bankSplitContacts.ts), applied
 * FIFO unless auto_apply is 'none', and carries no VAT and no dimensions. One bank
 * line can therefore pay two suppliers — a claimant's own bill and a merchant's
 * slip bill — without moving AP away from its subledger.
 *
 * UNATTENDED, unlike the screen: every GL line's vat_code goes through the same
 * guard as allocate_bank_transaction (allocationVatGuard → gl/ruleVatResolution)
 * and a claim the guard would change is REFUSED, as create_draft_journal does —
 * a split line names its own account, so silently relabelling the code would
 * leave the rest of the line describing a claim the code denies.
 *
 * Every refusal is answered from reads before the service call; after it,
 * failures propagate to the registry's savepoint (see the MCP .claude.md).
 */
import type { McpTool } from '../types';
import { splitAllocateTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { planSplitDimensionsForTransaction } from '@/modules/accounting/services/bank/bankSplitDimensions';
import { isBankAllocationRefusal } from '@/modules/accounting/services/bank/bankAllocationRefusal';
import { findBankTransactionAllocationStates } from '@/modules/accounting/services/bank/bankTransactionLookupService';
import { importerRefusalForLineId } from '@/modules/accounting/services/bank/bankLineImporterGate';
import { accountsBelongToCompany } from '@/modules/accounting/services/gl/chartOfAccountsService';
import { assertCustomerInCompany, assertSupplierInCompany } from '@/modules/accounting/services/core/contactDirectoryService';
import { isDimensionRefusal } from '@/modules/accounting/services/gl/dimensions/dimensionTypes';
import { AUTO_APPLY_MODES, type AutoApplyMode } from '@/modules/accounting/services/shared/autoAllocateStrategy';
import { SELECTOR_PROPERTIES } from './allocationSchema';
import { VAT_CODES, badUuidArg, pickTxSelector, resolveTxId, type VatCode } from './allocationLine';
import { resolveLineVatCode } from './allocationVatGuard';
import { DIMENSION_LINE_PROPERTIES, itemsWithDimensions, parseDimensionRefs } from './dimensionArgs';
import { mcpPostingOpts } from '../mcpActor';
import { MAX_MONEY, NOT_FOUND, hasWholeCents, ok, toolError } from './toolHelpers';
import type { DimensionRefs } from '@/modules/accounting/services/gl/dimensions/dimensionTypes';

const TOOL = 'split_allocate_bank_transaction';
export const MAX_SPLIT_LINES = 50;

interface ParsedSplitLine {
  contraAccountId?: string;
  contactType?: 'supplier' | 'customer';
  contactId?: string;
  autoApply?: AutoApplyMode;
  amount: number;
  vatCode?: VatCode;
  description?: string;
}

function hasDimensions(d: DimensionRefs | undefined): boolean {
  return Boolean(d && Object.values(d).some((v) => v !== undefined && v !== null && v !== ''));
}

function parseSplitLines(raw: unknown): { lines: ParsedSplitLine[]; dims: (DimensionRefs | undefined)[] } | string {
  if (!Array.isArray(raw) || raw.length < 2) return 'lines must hold at least two split lines';
  if (raw.length > MAX_SPLIT_LINES) return `lines holds ${raw.length} entries — at most ${MAX_SPLIT_LINES}`;
  const lines: ParsedSplitLine[] = [];
  const dims: (DimensionRefs | undefined)[] = [];
  for (const [i, entry] of raw.entries()) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return `lines[${i}] must be an object`;
    const o = entry as Record<string, unknown>;
    const str = (k: string) => (typeof o[k] === 'string' ? (o[k] as string).trim() : '');
    const contra = str('contra_account_id');
    const supplierId = str('supplier_id');
    const customerId = str('customer_id');
    const named = [contra, supplierId, customerId].filter(Boolean).length;
    if (named !== 1) return `lines[${i}] must name exactly one of contra_account_id, supplier_id, customer_id`;
    const badId = badUuidArg({ contra_account_id: contra, supplier_id: supplierId, customer_id: customerId },
      [contra ? 'contra_account_id' : supplierId ? 'supplier_id' : 'customer_id']);
    if (badId) return `lines[${i}]: ${badId}`;
    const amount = Number(o.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_MONEY || !hasWholeCents(amount)) {
      return `lines[${i}].amount must be a positive amount in whole cents`;
    }
    let vatCode: VatCode | undefined;
    if (o.vat_code !== undefined && o.vat_code !== null) {
      if (typeof o.vat_code !== 'string' || !(VAT_CODES as readonly string[]).includes(o.vat_code)) {
        return `lines[${i}].vat_code must be one of: ${VAT_CODES.join(', ')}`;
      }
      vatCode = o.vat_code as VatCode;
    }
    const d = parseDimensionRefs(o, `lines[${i}]`);
    if (typeof d === 'string') return d;
    const isContact = Boolean(supplierId || customerId);
    let autoApply: AutoApplyMode | undefined;
    if (o.auto_apply !== undefined && o.auto_apply !== null) {
      if (!isContact) return `lines[${i}].auto_apply applies only to a supplier_id / customer_id line`;
      if (typeof o.auto_apply !== 'string' || !(AUTO_APPLY_MODES as readonly string[]).includes(o.auto_apply)) {
        return `lines[${i}].auto_apply must be one of: ${AUTO_APPLY_MODES.join(', ')}`;
      }
      autoApply = o.auto_apply as AutoApplyMode;
    }
    if (isContact) {
      // A settlement: the bill / invoice already carried the VAT and the dimensions.
      const who = supplierId ? 'supplier' : 'customer';
      if (vatCode && vatCode !== 'none') return `lines[${i}] settles a ${who} — omit vat_code (the document already carried the VAT)`;
      if (hasDimensions(d)) return `lines[${i}] settles a ${who} — a settlement carries no cc1 / cc2 / bu`;
    }
    dims.push(isContact ? undefined : d);
    lines.push({
      ...(contra ? { contraAccountId: contra } : {}),
      ...(supplierId ? { contactType: 'supplier' as const, contactId: supplierId } : {}),
      ...(customerId ? { contactType: 'customer' as const, contactId: customerId } : {}),
      ...(autoApply ? { autoApply } : {}),
      amount, vatCode: isContact ? undefined : vatCode,
      description: typeof o.description === 'string' ? o.description.slice(0, 500) : undefined,
    });
  }
  return { lines, dims };
}

export const splitAllocateBankTransactionTool: McpTool = {
  name: TOOL,
  description:
    'Split ONE bank transaction across several lines — e.g. a paycard slip that is part fuel, part tolls, or one '
    + 'payment that settles two suppliers. Each line names exactly one of contra_account_id (a GL account, with its '
    + 'own vat_code and optional cc1 / cc2 / bu), supplier_id or customer_id. The line amounts are VAT-INCLUSIVE and '
    + 'must sum exactly to the transaction amount. POSTS one journal: a cost/revenue line per GL line (plus a VAT line '
    + 'where vat_code is standard), an AP/AR control line per supplier/customer line, and one bank line. A supplier/'
    + 'customer line gets its own payment, receipt or refund document on that journal, applied to the contact\'s '
    + 'oldest open documents unless auto_apply is "none" (then apply it with apply_payment_to_supplier_invoice / '
    + 'apply_receipt_to_invoice using the returned payment_id); it carries no VAT and no dimensions. Dimensions go on '
    + 'the GL cost/revenue lines only; a line on a control account may not carry them. When a GL line names none, the '
    + 'bank or card account\'s default dimensions apply. A cost-of-sales line with no project (cc2) is reported in '
    + 'dimension_warnings (or refused where the company requires a project). A vat_code the VAT guard would change '
    + '(no supply possible, or input tax denied) is REFUSED. Use dry_run to preview. Undo with reverse_bank_allocation, '
    + 'which also cancels every document the split created.',
  scope: 'write:bank-tx',
  write: true,
  requiresPost: true,
  inputSchema: {
    type: 'object',
    properties: {
      ...SELECTOR_PROPERTIES,
      lines: {
        type: 'array',
        minItems: 2,
        maxItems: MAX_SPLIT_LINES,
        items: {
          type: 'object',
          properties: {
            contra_account_id: { type: 'string', description: 'GL account UUID for this part of the transaction' },
            supplier_id: { type: 'string', description: 'Supplier UUID: this part pays (or is refunded by) that supplier' },
            customer_id: { type: 'string', description: 'Customer UUID: this part is a receipt from (or refund to) that customer' },
            auto_apply: {
              type: 'string', enum: [...AUTO_APPLY_MODES],
              description: 'Supplier/customer lines only: "fifo" (default) applies to the oldest open documents; "none" leaves it on account.',
            },
            amount: { type: 'number', exclusiveMinimum: 0, description: 'VAT-inclusive amount of this part' },
            vat_code: { type: 'string', enum: [...VAT_CODES] },
            description: { type: 'string' },
            ...DIMENSION_LINE_PROPERTIES,
          },
          required: ['amount'],
          additionalProperties: false,
        },
      },
      dry_run: { type: 'boolean', description: 'Validate and preview; write nothing.' },
      idempotency_key: { type: 'string' },
    },
    required: ['lines', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const selector = pickTxSelector(args);
    if (typeof selector === 'string') return toolError(selector);
    const badId = badUuidArg(args, ['transaction_id', 'bank_account_id']);
    if (badId) return toolError(badId);
    const parsed = parseSplitLines(args.lines);
    if (typeof parsed === 'string') return toolError(parsed);

    const accountIds = parsed.lines.flatMap((l) => (l.contraAccountId ? [l.contraAccountId] : []));
    if (accountIds.length > 0 && !(await accountsBelongToCompany(ctx.companyId, accountIds))) {
      return toolError(NOT_FOUND);
    }
    for (const l of parsed.lines) {
      if (!l.contactId) continue;
      try {
        if (l.contactType === 'supplier') await assertSupplierInCompany(ctx.companyId, l.contactId);
        else await assertCustomerInCompany(ctx.companyId, l.contactId);
      } catch {
        return toolError(NOT_FOUND);
      }
    }
    const lines = await itemsWithDimensions(ctx.companyId, parsed.lines, parsed.dims, (i) => `lines[${i}]`);
    if (typeof lines === 'string') return toolError(lines);

    const resolved = await resolveTxId(selector, ctx.companyId);
    if ('error' in resolved) return toolError(resolved.error);
    const state = (await findBankTransactionAllocationStates(ctx.companyId, [resolved.id])).get(resolved.id);
    if (!state) return toolError(NOT_FOUND);
    if (state.status !== 'imported' || state.matchedJournalLineId) {
      return toolError(`Transaction already ${state.status} — cannot split allocate`);
    }
    const total = Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
    if (Math.abs(total - Math.abs(state.amount)) > 0.005) {
      return toolError(`Split lines total R${total.toFixed(2)} does not equal the transaction amount R${Math.abs(state.amount).toFixed(2)}`);
    }
    const accountLines = lines.map((l, index) => ({ l, index })).filter(({ l }) => Boolean(l.contraAccountId));
    // Step 2: the token's user importing the statement this line came from is refused by the service too — asked here
    // so the dry run gives the same refusal. (Contact lines are checked per arm by the service.)
    if (accountLines.length > 0) {
      const importerRefusal = await importerRefusalForLineId(ctx.companyId, resolved.id, ctx.userId, 'manual_journal');
      if (importerRefusal) return toolError(importerRefusal.message);
    }

    for (const { l: line, index: i } of accountLines) {
      if (!line.vatCode || line.vatCode === 'none') continue;
      const guarded = await resolveLineVatCode(
        ctx.companyId, resolved.id, { allocType: 'account', contraAccountId: line.contraAccountId!, vatCode: line.vatCode }, TOOL,
      );
      if (guarded.vatCoerced) {
        return toolError(`lines[${i}].vat_code ${line.vatCode} is not claimable on that account (${guarded.vatCoerced.reason}).`);
      }
    }

    let plan: Awaited<ReturnType<typeof planSplitDimensionsForTransaction>>;
    try {
      plan = await planSplitDimensionsForTransaction(ctx.companyId, resolved.id,
        accountLines.map(({ l }) => ({ ...l, contraAccountId: l.contraAccountId! })));
    } catch (err) {
      // Reads only: a dimension on a control account, or a COS line with no project where required.
      if (isBankAllocationRefusal(err) || isDimensionRefusal(err)) return toolError(err.message);
      throw err;
    }
    if (!plan) return toolError(NOT_FOUND);
    const dimPlan = plan;
    const dimsByIndex = new Map(accountLines.map(({ index }, k) => [index, dimPlan.dims[k]]));
    const warnings = dimPlan.warnings.length > 0 ? { dimension_warnings: dimPlan.warnings } : {};

    if (args.dry_run === true) {
      const preview = ok({
        dry_run: true,
        transaction_id: resolved.id,
        lines: lines.map((l, i) => (l.contactId
          ? {
            [l.contactType === 'supplier' ? 'supplier_id' : 'customer_id']: l.contactId,
            amount: l.amount, auto_apply: l.autoApply ?? 'fifo',
          }
          : {
            contra_account_id: l.contraAccountId, amount: l.amount, vat_code: l.vatCode ?? null,
            cc1_id: dimsByIndex.get(i)?.cc1Id ?? null, cc2_id: dimsByIndex.get(i)?.cc2Id ?? null, bu_id: dimsByIndex.get(i)?.buId ?? null,
          })),
        ...warnings,
      });
      preview.wroteNothing = true;
      preview.billable = false;
      return preview;
    }

    // No catch below: anything the service throws must reach the registry's savepoint.
    const result = await splitAllocateTransaction(ctx.companyId, resolved.id, lines.map((l) => (l.contactId
      ? { contactType: l.contactType, contactId: l.contactId, autoApply: l.autoApply, amount: l.amount, description: l.description }
      : {
        contraAccountId: l.contraAccountId, amount: l.amount, description: l.description,
        vatCode: l.vatCode === 'none' ? undefined : l.vatCode, cc1Id: l.cc1Id, cc2Id: l.cc2Id, buId: l.buId,
      })), ctx.userId, mcpPostingOpts(ctx, TOOL));
    return ok({
      journal_entry_id: result.journalEntryId,
      transaction_id: result.bankTransaction.id,
      ...(result.contactDocuments
        ? {
          contact_documents: result.contactDocuments.map((d) => ({
            line: d.index,
            [d.kind === 'supplier' ? 'supplier_id' : 'customer_id']: d.contactId,
            document: d.document,
            payment_id: d.paymentId,
            applications: d.applications.map((a) => ({ document_id: a.documentId, document_number: a.documentNumber, amount: a.amount })),
            on_account: d.onAccount,
          })),
        }
        : {}),
      ...(result.lateClaim ? { late_claim: result.lateClaim } : {}),
      ...warnings,
    });
  },
};
