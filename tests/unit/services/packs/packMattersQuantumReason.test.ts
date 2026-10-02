/**
 * THE REASON A MATTER HAS NO RAND AMOUNT IS TRUE OF EVERY MATTER IT MARKS.
 *
 * Page 11's quantum column prints `n/m` against one lettered reason for every
 * matter with no single amount, and that reason read "… — an overdue filing,
 * or a check that found nothing to quantify." Since the unreconciled-bank
 * backlog whose items net to nil carries no amount either, the note told the
 * board a bank reconciliation backlog was an overdue filing. One sentence,
 * true of all of them, keeps it one lettered note on a page budgeted in rows.
 */
import { describe, expect, it } from 'vitest';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import type { PackMatter } from '@/modules/accounting/services/packs/pages/packMatters';
import { BOARD_DECISIONS } from '@/modules/accounting/services/packs/pages/packMatterDecisions';
import { demoInput } from './fixtures/boardPackInputs';

const MOVEMENT = 'Not tracked — no prior board pack is stored to compare against.';

/** As `unreconciledBankMatters` writes it where the items net to nil. */
const BANK_NETS_TO_NIL: PackMatter = {
  kind: 'finding',
  issue: '4 unreconciled bank items across 2 bank accounts, as at the time this pack was extracted '
    + 'rather than at the period end; receipts and payments among them net to nil on each account, '
    + 'so no amount is stated',
  quantum: null,
  owner: 'Bookkeeping',
  movement: MOVEMENT,
  decisionRequired: BOARD_DECISIONS.unreconciledBank,
};

/** As `overdueFilingMatters` writes one. */
const OVERDUE_FILING: PackMatter = {
  kind: 'finding',
  issue: 'Annual Financial Statements for FY2024: 739 days overdue (due 28 August 2024)',
  quantum: null,
  owner: 'Company secretary',
  movement: MOVEMENT,
  decisionRequired: BOARD_DECISIONS.overdueFiling,
};

function reasonFor(matters: PackMatter[], issue: string): string | undefined {
  const page = buildBoardPackPages({ ...demoInput, matters }).pages
    .find((p) => p.blocks.some((b) => b.kind === 'matters'))!;
  const block = page.blocks.find((b) => b.kind === 'matters');
  if (block === undefined || block.kind !== 'matters') throw new Error('page 11 prints no matters table');
  const row = block.matters.find((m) => m.issue === issue);
  expect(row, 'the matter is not on page 11').toBeDefined();
  expect(row!.quantum.value).toBeNull();
  return row!.quantum.unavailable;
}

describe('page 11 says why a matter has no rand amount', () => {
  it('does not call a bank backlog that nets to nil an overdue filing', () => {
    const reason = reasonFor([BANK_NETS_TO_NIL], BANK_NETS_TO_NIL.issue);
    expect(reason).toBeTruthy();
    expect(reason).not.toMatch(/overdue filing/i);
  });

  it('gives an overdue filing the same reason, so the page carries one note', () => {
    const both = [BANK_NETS_TO_NIL, OVERDUE_FILING];
    expect(reasonFor(both, OVERDUE_FILING.issue)).toBe(reasonFor(both, BANK_NETS_TO_NIL.issue));
  });
});
