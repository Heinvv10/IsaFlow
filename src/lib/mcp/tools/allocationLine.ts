/**
 * One allocation line — shared by `allocate_bank_transaction` (one line) and
 * `bulk_allocate_bank_transactions` (up to 500).
 *
 * Everything here was lifted out of writeBankAllocate.ts when the bulk tool
 * arrived. Duplicating it would have been the real risk: the tenant-ownership
 * checks and the alloc_type/vat_code runtime gates are the only thing standing
 * between an agent-supplied UUID and a cross-tenant journal, and a bulk copy
 * that drifted one revision behind would be a silent hole 500 lines wide.
 * Single and bulk therefore parse, own-check, resolve and post through exactly
 * these functions.
 */
import {
  accountsBelongToCompany,
} from '@/modules/accounting/services/gl/chartOfAccountsService';
import {
  customersBelongToCompany,
  suppliersBelongToCompany,
} from '@/modules/accounting/services/core/contactDirectoryService';
import { allocateTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { findBankTransactionsByReference } from '@/modules/accounting/services/bank/bankTransactionLookupService';
import { mcpPostingAgent } from '../postingAgent';
import { NOT_FOUND, guardCastableArgs } from './toolHelpers';

// inputSchema.enum is NOT enforced by the MCP transport (schema is passed
// through to getManifest() only) — this array is the actual runtime gate.
// AllocationType in bankAllocationService also has a 'transfer' member with
// live bank-to-bank-transfer semantics; these tools deliberately do not expose
// it, so it must be rejected here rather than silently coerced.
export const ALLOC_TYPES = ['account', 'supplier', 'customer'] as const;
export type AllocType = (typeof ALLOC_TYPES)[number];

// Same reasoning, same runtime gate. bankAllocationService maps any value it
// doesn't recognise to `undefined` (mapVatType), which posts the line with NO
// VAT type at all — a typo like 'zero-rated' silently drops the VAT201
// classification off a journal that still balances. Reject, never coerce.
export const VAT_CODES = ['standard', 'zero_rated', 'exempt', 'none'] as const;
export type VatCode = (typeof VAT_CODES)[number];

// allocateTransaction gates its supplier/customer branches on `allocType &&
// entityId`; a falsy entityId falls through to the plain GL-account branch and
// posts a structurally different journal (no AP/AR control account, no match)
// under a success response. The REST route over the same service rejects this
// explicitly — see pages/api/accounting/bank-transactions-action.ts.
const ENTITY_REQUIRED: readonly AllocType[] = ['supplier', 'customer'];

// allocateTransaction reads contraAccountId ONLY in its `account` branch —
// supplier/customer resolve their contra side from getSystemAccountId
// ('payable'/'receivable'). Requiring it everywhere made the agent invent a GL
// account for a supplier payment that then went unused.
const CONTRA_REQUIRED: readonly AllocType[] = ['account'];

// ── Transaction selector (PRD-11 §5) ────────────────────────────────────────
//
// The agent reads a bank statement, not the database, so it holds the printed
// `bank_reference` rather than a UUID. Exactly one of the two: given both, they
// can name different rows and there is no safe precedence — a tie-break here
// would post against whichever the tool happened to prefer.
export type TxSelector = { txId: string } | { ref: string; bankAccountId?: string };

export interface AllocationLine {
  selector: TxSelector;
  contraAccountId: string;
  allocType: AllocType;
  entityId: string;
  vatCode?: VatCode;
  invoiceId?: string;
  description?: string;
}

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  return typeof v === 'string' ? v.trim() : '';
}

// Every id on a line is a uuid column, and a malformed one reaches pg as
// `'not-a-uuid'::uuid` — 22P02. The shared `guardCastableArgs` (toolHelpers,
// PR #266) is the one place that decides what survives a cast, so it is reused
// here rather than re-implementing the regex: a per-line copy would drift from
// the guard every other tool uses and from `UUID_RE` in lib/validation.
//
// It matters more per-line than per-tool. The batch ownership check sends ONE
// array for all 500 lines, so a single bad id fails the query for the whole
// batch, and the agent is told only that something, somewhere, was wrong.
//
// `guardCastableArgs` returns a tool RESULT; this module speaks in refusal
// STRINGS because the bulk caller prefixes each with its line index. Unwrapping
// keeps the wording identical for the single tool and every bulk line.
const CASTABLE_LINE_UUIDS = [
  'transaction_id', 'bank_account_id', 'contra_account_id', 'entity_id', 'invoice_id',
] as const;

/** The shared guard's refusal text for `args`, or null when every id is usable. */
function badUuidArg(args: Record<string, unknown>, keys: readonly string[]): string | null {
  const refusal = guardCastableArgs(args, { uuid: keys });
  return refusal ? refusal.content[0]!.text : null;
}

/** Returns the selector, or the error text to refuse with. */
export function pickTxSelector(args: Record<string, unknown>): TxSelector | string {
  const txId = str(args, 'transaction_id');
  const ref = str(args, 'bank_reference');
  if (txId && ref) {
    return 'Provide either transaction_id or bank_reference, not both — they may name different transactions.';
  }
  if (!txId && !ref) return 'transaction_id or bank_reference is required';
  if (txId) return { txId };
  // bank_account_id only NARROWS a query already fenced to ctx.companyId, so
  // it never becomes a foreign key and needs no ownership check of its own:
  // a foreign id simply matches nothing.
  const bankAccountId = str(args, 'bank_account_id');
  return bankAccountId ? { ref, bankAccountId } : { ref };
}

/** Validates one line's shape. Returns the parsed line or the refusal text. */
export function parseAllocationLine(args: Record<string, unknown>): AllocationLine | string {
  // Selector FIRST, cast-guards second — the order the single tool has always
  // used (writeBankAllocate.ts before this module was extracted from it), and
  // it is a behavioural contract, not a formatting detail. Guarding first
  // changes what a doubly-faulty line is told:
  //
  //   malformed contra_account_id + NO selector
  //     → 'transaction_id or bank_reference is required', not 'invalid
  //       contra_account_id'. The missing selector is the bigger fault; a
  //       contra account is meaningless without a transaction to book it to.
  //   malformed transaction_id + a bank_reference
  //     → the either/not-both refusal, not 'invalid transaction_id'. Told the
  //       id is malformed, an agent fixes the UUID and gets refused again for
  //       naming both. It has to be told about the ambiguity first.
  const selector = pickTxSelector(args);
  if (typeof selector === 'string') return selector;

  // Now the casts. Everything below and every ownership lookup puts these into
  // a $n::UUID, so an id that cannot survive the cast makes them meaningless.
  const badId = badUuidArg(args, CASTABLE_LINE_UUIDS);
  if (badId) return badId;

  const rawAllocType = args.alloc_type;
  let allocType: AllocType = 'account';
  if (rawAllocType !== undefined) {
    if (typeof rawAllocType !== 'string' || !ALLOC_TYPES.includes(rawAllocType as AllocType)) {
      return `alloc_type must be one of: ${ALLOC_TYPES.join(', ')}`;
    }
    allocType = rawAllocType as AllocType; // validated by the .includes() check above
  }

  const rawVatCode = args.vat_code;
  let vatCode: VatCode | undefined;
  if (rawVatCode !== undefined) {
    if (typeof rawVatCode !== 'string' || !VAT_CODES.includes(rawVatCode as VatCode)) {
      return `vat_code must be one of: ${VAT_CODES.join(', ')}`;
    }
    vatCode = rawVatCode as VatCode; // validated by the .includes() check above
  }

  const entityId = str(args, 'entity_id');
  if (ENTITY_REQUIRED.includes(allocType) && !entityId) {
    return `entity_id is required for ${allocType} allocation`;
  }
  const contraAccountId = str(args, 'contra_account_id');
  if (CONTRA_REQUIRED.includes(allocType) && !contraAccountId) {
    return `contra_account_id is required for ${allocType} allocation`;
  }

  // DELIBERATE CHANGE from the pre-extraction handler, which passed
  // args.invoice_id through raw: it is trimmed here, and a blank/whitespace
  // value becomes `undefined` rather than reaching allocateTransaction as ''.
  // An empty string there is falsy anyway, so the service behaved identically —
  // but '  ' is NOT, and it would have been matched against invoice ids as a
  // literal two-space string. Every other id on this line is trimmed the same
  // way; leaving one raw was the inconsistency, not the fix.
  const invoiceId = str(args, 'invoice_id');

  const description = typeof args.description === 'string' ? args.description : undefined;
  return {
    selector,
    contraAccountId,
    allocType,
    entityId,
    vatCode,
    invoiceId: invoiceId || undefined,
    description,
  };
}

/**
 * Tenant ownership for a whole set of lines — three queries, whatever the line
 * count.
 *
 * These ids arrive from the agent, and NOTHING downstream re-checks the tenant:
 * allocateTransaction looks the contra account up only to build a display
 * label, sets it null on zero rows, and posts the line anyway; there is no
 * composite (id, company_id) FK to catch it. A foreign contra_account_id books
 * this company's bank money into another tenant's account, and a foreign
 * entity_id books it against another tenant's creditor/debtor.
 *
 * Returns `null` when everything belongs to companyId, and the shared NOT_FOUND
 * text otherwise. That text is deliberately identical to a genuine miss: a
 * distinguishable "belongs to another company" reply would turn these tools
 * into an existence oracle — an agent could probe UUIDs and learn which ones
 * are real in tenants it cannot read. It also means the batch cannot say WHICH
 * line was foreign, which is the correct trade.
 */
export async function checkLinesOwnership(
  companyId: string,
  lines: AllocationLine[],
): Promise<string | null> {
  const accountIds = [...new Set(lines.map((l) => l.contraAccountId).filter(Boolean))];
  const supplierIds = [
    ...new Set(lines.filter((l) => l.allocType === 'supplier').map((l) => l.entityId)),
  ];
  const customerIds = [
    ...new Set(lines.filter((l) => l.allocType === 'customer').map((l) => l.entityId)),
  ];

  // An empty set is vacuously owned, and the query is SKIPPED rather than sent
  // with an empty array: a supplier-only batch has no contra accounts to check,
  // and a round trip that can only answer true is pure latency on the hot path.
  const [accountsOk, suppliersOk, customersOk] = await Promise.all([
    accountIds.length ? accountsBelongToCompany(companyId, accountIds) : true,
    supplierIds.length ? suppliersBelongToCompany(companyId, supplierIds) : true,
    customerIds.length ? customersBelongToCompany(companyId, customerIds) : true,
  ]);
  return accountsOk && suppliersOk && customersOk ? null : NOT_FOUND;
}

/** Resolves a selector to one transaction id, or the error text to refuse with. */
export async function resolveTxId(
  sel: TxSelector,
  companyId: string,
): Promise<{ id: string } | { error: string }> {
  if ('txId' in sel) return { id: sel.txId };
  const matches = await findBankTransactionsByReference(companyId, sel.ref, sel.bankAccountId);
  // Same text as a genuine miss: a reference that resolves in another tenant
  // must read identically to one that exists nowhere (no existence oracle).
  if (matches.length === 0) return { error: NOT_FOUND };
  if (matches.length > 1) {
    // Never take the first: same-reference rows differ by date and amount, and
    // guessing posts this month's journal against last month's transaction.
    const listed = matches
      .map((m) => `${m.id} (${m.transactionDate}, ${m.amount.toFixed(2)})`)
      .join('; ');
    return {
      error: `bank_reference is ambiguous — ${matches.length} transactions carry it: ${listed}. `
        + 'Re-issue with transaction_id, or narrow with bank_account_id.',
    };
  }
  return { id: matches[0]!.id };
}

/**
 * Posts one line. The ONLY call site of allocateTransaction in the MCP layer —
 * a second posting path is how the postingAgent stamp gets lost, and an
 * unstamped journal drops out of list_agent_postings, the control surface every
 * other agent write depends on.
 *
 * Throws on failure. Callers decide whether that becomes a toolError (single
 * line: nothing else was written) or propagates to roll the batch back.
 */
export async function postAllocationLine(
  companyId: string,
  userId: string,
  txId: string,
  line: AllocationLine,
  toolName: string,
): Promise<{ journalEntryId: string; transactionId: string }> {
  const result = await allocateTransaction(
    companyId,                                                // tenant from ctx ONLY
    txId,
    line.contraAccountId || null,  // null for supplier/customer — the service ignores it there
    userId,
    line.description,
    line.allocType,
    line.entityId || undefined,
    line.vatCode,
    undefined,
    undefined,
    undefined,
    line.invoiceId,
    { postingAgent: mcpPostingAgent(toolName) },
  );
  return { journalEntryId: result.journalEntryId, transactionId: result.bankTransaction.id };
}
