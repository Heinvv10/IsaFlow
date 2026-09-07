/**
 * THE DECISION EACH MATTER ON PAGES 4 AND 11 IS WAITING ON.
 *
 * Its own module, and it holds five strings, because the two files that write
 * matters are `packMatters.ts` (four ledger checks and a failed one) and
 * `packDerivedMatters.ts` (the credit month), and the FIXTURES that stand in
 * for the ledger have to state the same wordings. `packMatters.ts` reaches
 * the database on import, so a fixture importing the record from there forces
 * every test that mocks that module wholesale to load the real one.
 *
 * EVERY ONE OF THEM IS A QUESTION, BECAUSE PAGE 4 SAYS THEY ARE.
 *
 * The action-panel disclosure states that the panel "states the decision each
 * matter is waiting on, NEVER A RECOMMENDATION", and the column beneath it
 * printed "Approve immediate filing and confirm any penalty exposure" on two
 * demo rows and one Brightsphere row. That is a course of action recommended
 * in the imperative; the twelfth visual gate failed criterion 7 on the
 * contradiction between a sentence and the table under it. Three of the other
 * four read the same way ("Approve time and resource…", "Confirm supporting
 * evidence…", "Identify the reversals…") and only the debtor row genuinely
 * put a choice to the board.
 *
 * BOTH ENDS WERE FIXABLE AND THIS IS THE END THAT WAS WRONG. A board pack
 * that tells a board what to approve has taken the decision the board is
 * being convened to take — the claim is the right one to make, and it is the
 * table that had drifted from it. Nothing is hedged: the claim still says
 * "never", it is still checkable off the page, and it is now true of every
 * row, including the statutory filing where only one course is lawful (the
 * board still decides whether to file NOW and what exposure to accept in
 * doing so).
 *
 * They are one record rather than six literals so that the claim on page 4
 * and the strings under it cannot drift apart again — the wordings drifted
 * silently through eleven visual gates. `packMatterDecisions.test.ts` holds
 * the record to its shape and to that claim in the same file.
 *
 * `NO_MATTERS` is deliberately NOT here: "None. Note for the record." is the
 * absence of a decision, and phrasing it as one would be the pack inventing
 * a question the board does not have.
 */
export const BOARD_DECISIONS = {
  agedDebtorConcentration: 'Whether to escalate, hold credit, or refer the account for write-off.',
  unreconciledBank: 'Whether to commit time and resource to clearing the backlog.',
  unusualJournal: "Whether the entry's evidence stands, or it is referred for reversal.",
  overdueFiling: 'Whether to file immediately, accepting any penalty exposure.',
  creditMonth: 'Whether the reversals behind the credit belong to this period.',
  checkFailed: 'Whether to re-run this check before the meeting, or proceed without it.',
} as const;
