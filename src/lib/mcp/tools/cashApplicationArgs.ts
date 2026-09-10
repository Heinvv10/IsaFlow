/**
 * Argument parsing shared by `apply_receipt_to_invoice` and
 * `apply_payment_to_supplier_invoice`.
 *
 * The two tools take the same `allocations` array and differ only in which
 * subledger they settle. Parsing it once means an agent that has learned one
 * gets the same refusals, with the same wording and the same line indices, from
 * the other — and it keeps the UUID guards in one place, where a `$n::UUID`
 * cast can be proven to be covered.
 *
 * Every refusal here is a fault in the REQUEST and happens before any read or
 * write, so it names the offending line's INDEX rather than making an agent
 * bisect its own batch.
 */
import type { McpToolResult } from '../types';
import { UUID_RE } from '@/lib/validation';
import { hasWholeCents, toolError } from './toolHelpers';

/**
 * The payment_id branch executes only against a prepared, independently
 * approved cash application intent (cashApplicationLegacyAdapter.ts, d41ebe848),
 * and this connector cannot prepare one yet. A preview must say so rather than
 * report balances the live call can never move.
 */
export const CASH_APPLICATION_INTENT_REQUIRED_TEXT =
  'A prepared cash application intent and independent approval are required to apply an '
  + 'existing payment, and this connector cannot prepare one yet. Nothing was previewed. '
  + 'Use the bank_transaction_id source for an imported bank line.';

/** More lines than this in one application is a mistake, not a batch. */
const MAX_ALLOCATION_LINES = 200;

export interface ParsedAllocation {
  invoiceId: string;
  amount: number;
}

export type ParseResult =
  | { ok: true; allocations: ParsedAllocation[] }
  | { ok: false; error: McpToolResult };

/**
 * Parse and validate `args.allocations`.
 *
 * @param idKey The property naming the document on each line — `invoice_id` on
 *   both tools today, kept a parameter so the wording of every refusal matches
 *   the schema the agent was given rather than a generic one.
 */
export function parseAllocations(
  args: Record<string, unknown>,
  idKey: string,
): ParseResult {
  const raw = args.allocations;
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: toolError('allocations must be a non-empty array') };
  }
  if (raw.length > MAX_ALLOCATION_LINES) {
    return {
      ok: false,
      error: toolError(
        `allocations has ${raw.length} lines; the maximum is ${MAX_ALLOCATION_LINES}. `
        + 'Split it across several receipts.',
      ),
    };
  }

  const allocations: ParsedAllocation[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i];
    if (typeof line !== 'object' || line === null || Array.isArray(line)) {
      return { ok: false, error: toolError(`allocations[${i}] must be an object`) };
    }
    const rec = line as Record<string, unknown>;
    const id = typeof rec[idKey] === 'string' ? (rec[idKey] as string).trim() : '';
    if (!id) {
      return { ok: false, error: toolError(`allocations[${i}].${idKey} is required`) };
    }
    // The id reaches pg as `$n::UUID`, where a malformed value raises 22P02 and
    // surfaces as a generic failure naming nothing.
    if (!UUID_RE.test(id)) {
      return { ok: false, error: toolError(`allocations[${i}].${idKey} is not a valid id`) };
    }
    if (seen.has(id)) {
      return {
        ok: false,
        error: toolError(`allocations[${i}].${idKey} appears more than once — combine the lines`),
      };
    }
    seen.add(id);

    const amount = Number(rec.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return {
        ok: false,
        error: toolError(`allocations[${i}].amount must be a positive number`),
      };
    }
    if (!hasWholeCents(amount)) {
      return {
        ok: false,
        error: toolError(
          `allocations[${i}].amount has more than two decimal places (${amount}) — `
          + 'amounts are stored to the cent.',
        ),
      };
    }
    allocations.push({ invoiceId: id, amount });
  }
  return { ok: true, allocations };
}

/** JSON Schema fragment for the allocations array, shared by both tools. */
export function allocationsSchema(idKey: string, documentLabel: string): Record<string, unknown> {
  return {
    type: 'array',
    minItems: 1,
    maxItems: MAX_ALLOCATION_LINES,
    description: `Which ${documentLabel} this cash settles, and how much of it goes to each.`,
    items: {
      type: 'object',
      properties: {
        [idKey]: { type: 'string', description: `${documentLabel} UUID` },
        amount: {
          type: 'number',
          exclusiveMinimum: 0,
          description: 'Amount applied to this document, to the cent. Never more than its outstanding balance.',
        },
      },
      required: [idKey, 'amount'],
      additionalProperties: false,
    },
  };
}
