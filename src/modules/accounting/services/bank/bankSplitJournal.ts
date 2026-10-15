/**
 * The journal lines of a SPLIT bank allocation, built from the plans
 * `splitAllocateTransaction` decided from reads. Moved out of
 * bankAllocationService.ts (line cap) when split lines gained suppliers and
 * customers (bankSplitContacts.ts).
 *
 * Per split line, in order: a GL-account line posts its cost/revenue leg (net
 * of VAT when vat_code is standard, plus the VAT leg) with its dimensions; a
 * contact line posts one AP/AR control leg, no VAT, no dimensions. Then the
 * bank leg for the whole amount.
 */
import type { JournalLineInput } from '../../types/gl.types';
import type { DimensionIds } from '../gl/dimensions/dimensionTypes';
import { resolveVatAccountId } from './bankVatAccountResolver';
import { vatInclusiveSplit } from './bankVatInclusive';
import { BankAllocationRefusal } from './bankAllocationRefusal';
import type { SplitLine } from './bankAllocationTypes';
import type { PlannedSplitContact } from './bankSplitContacts';

/** A split line that posts to a GL account. */
export type AccountSplitLine = SplitLine & { contraAccountId: string };

/** Each split line, in order: a contact line's plan, or a GL-account line. */
export type SplitPart =
  | { kind: 'contact'; index: number; plan: PlannedSplitContact }
  | { kind: 'account'; index: number; line: AccountSplitLine };

/**
 * The split's lines as parts: every line a contact plan claimed is a contact
 * part, the rest must name a GL account. A line that names neither is refused
 * (a read-only refusal: nothing has been written yet).
 */
export function splitParts(lines: readonly SplitLine[], contactPlan: readonly PlannedSplitContact[]): SplitPart[] {
  const byIndex = new Map(contactPlan.map((p) => [p.index, p]));
  return lines.map((line, index): SplitPart => {
    const plan = byIndex.get(index);
    if (plan) return { kind: 'contact', index, plan };
    const { contraAccountId } = line;
    if (!contraAccountId) {
      throw new BankAllocationRefusal(`Split line ${index + 1} names neither a GL account nor a supplier/customer`);
    }
    return { kind: 'account', index, line: { ...line, contraAccountId } };
  });
}

export async function buildSplitJournalLines(args: {
  companyId: string;
  parts: readonly SplitPart[];
  /** Per GL-account part, by its line index. */
  dimsByIndex: ReadonlyMap<number, DimensionIds | undefined>;
  isSpent: boolean;
  entryDesc: string;
  bankAccountId: string;
  totalAmount: number;
}): Promise<JournalLineInput[]> {
  const { companyId, isSpent, entryDesc } = args;
  const journalLines: JournalLineInput[] = [];
  for (const part of args.parts) {
    if (part.kind === 'contact') {
      const contact = part.plan;
      // DR AP (payment) / CR AR (receipt), or the mirror for a refund — on the
      // control account, no VAT and no dimensions; the document follows the post.
      journalLines.push(isSpent
        ? { glAccountId: contact.controlAccountId, debit: contact.amount, credit: 0, description: contact.description }
        : { glAccountId: contact.controlAccountId, debit: 0, credit: contact.amount, description: contact.description });
      continue;
    }
    const { line } = part;
    const lineDims = args.dimsByIndex.get(part.index) ?? {};
    // Attended path, same as allocateTransaction: the split modal warned, the
    // user chose. Not coerced here.
    const lineVatCode = line.vatCode;
    const hasVat = lineVatCode === 'standard';
    const { netAmount, vatAmount } = vatInclusiveSplit(Number(line.amount), hasVat);
    // A GL-account line (contact lines left the loop above), so the direction
    // genuinely IS the only signal available.
    const vatAccountKey = isSpent ? 'vat_input' as const : 'vat_output' as const;
    const lineDesc = line.description || entryDesc;
    const mapVatType = lineVatCode === 'standard' ? 'standard' as const
      : lineVatCode === 'zero_rated' ? 'zero_rated' as const
      : lineVatCode === 'exempt' ? 'exempt' as const : undefined;
    journalLines.push(isSpent
      ? { glAccountId: line.contraAccountId, debit: netAmount, credit: 0, description: lineDesc, vatType: mapVatType, ...lineDims }
      : { glAccountId: line.contraAccountId, debit: 0, credit: netAmount, description: lineDesc, vatType: mapVatType, ...lineDims });
    if (hasVat) {
      const vatAcctId = await resolveVatAccountId(vatAccountKey, companyId);
      journalLines.push(isSpent
        ? { glAccountId: vatAcctId, debit: vatAmount, credit: 0, description: 'VAT @ 15%', vatType: 'standard' }
        : { glAccountId: vatAcctId, debit: 0, credit: vatAmount, description: 'VAT @ 15%', vatType: 'standard' });
    }
  }

  if (isSpent) {
    journalLines.push({ glAccountId: args.bankAccountId, debit: 0, credit: args.totalAmount, description: entryDesc });
  } else {
    journalLines.unshift({ glAccountId: args.bankAccountId, debit: args.totalAmount, credit: 0, description: entryDesc });
  }
  return journalLines;
}
