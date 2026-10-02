/**
 * PAGE 4 SAYS THE PANEL NEVER RECOMMENDS. THIS HOLDS THE COLUMN TO IT.
 *
 * The action-panel disclosure states that the panel "states the decision each
 * matter is waiting on, never a recommendation" — a strong, checkable claim,
 * and the twelfth visual gate found the table beneath it printing "Approve
 * immediate filing and confirm any penalty exposure" on two demo rows and one
 * Brightsphere row. Three of the other five read the same way. The claim was
 * kept and the wordings were fixed, because a pack that tells a board what to
 * approve has taken the decision the board is convened to take.
 *
 * A claim in prose and five string literals in another file is exactly the
 * pair that drifts, and it drifted silently through eleven gates. So the
 * decisions are ONE record and this holds three things together: every
 * decision is a question, no decision opens with the imperative the gate
 * caught, and the sentence that makes the claim is still on page 4. Reverting
 * any one of the wordings — or dropping the "never" — turns one of these red.
 */
import { describe, expect, it } from 'vitest';
import { BOARD_DECISIONS } from '@/modules/accounting/services/packs/pages/packMatterDecisions';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { liveDemoRenderedInput } from './fixtures/liveDemoBoardPack';
import { demoInput } from './fixtures/boardPackInputs';

/** The one string a board pack can print that IS the imperative and is not a
 *  recommendation: it recommends nothing because there is nothing to decide.
 *  It is `NO_MATTERS`, and it is deliberately outside the record below. */
const NO_DECISION = 'None. Note for the record.';

describe('every decision the pack puts to the board is a question', () => {
  it('opens each one with "Whether"', () => {
    const entries = Object.entries(BOARD_DECISIONS);
    // Six sources: four ledger checks, the derived credit month, and a check
    // that failed. A record that has quietly shrunk is a source whose wording
    // moved back into a literal.
    expect(entries.length).toBe(6);
    for (const [name, decision] of entries) {
      expect(decision, `${name} does not put a question to the board`).toMatch(/^Whether\b/);
      expect(decision, `${name} is not a sentence`).toMatch(/\.$/);
    }
  });

  it('never opens one with the imperative the gate caught', () => {
    for (const [name, decision] of Object.entries(BOARD_DECISIONS)) {
      expect(decision, `${name} recommends a course of action`)
        .not.toMatch(/^(Approve|Confirm|Identify|Re-run|Review|Escalate|File)\b/);
    }
  });

  it('keeps the claim that says so on page 4, unhedged', () => {
    for (const input of [liveDemoRenderedInput, demoInput]) {
      const page = buildBoardPackPages(input).pages
        .find((p) => p.navLabel === 'Commentary and actions')!;
      const notes = page.blocks
        .flatMap((b) => (b.kind === 'disclosure' ? b.disclosure.notes.map((n) => n.body) : []))
        .join(' ');
      expect(notes).toContain('states the decision each matter is waiting on, never a recommendation');
    }
  });

  it('prints only those decisions on the two governance pages', () => {
    const allowed = new Set<string>([...Object.values(BOARD_DECISIONS), NO_DECISION]);
    for (const input of [liveDemoRenderedInput, demoInput]) {
      const printed = buildBoardPackPages(input).pages
        .flatMap((p) => p.blocks)
        .flatMap((b) => (b.kind === 'matters' ? b.matters : []))
        .map((m) => m.decisionRequired);
      expect(printed.length, 'no matter is printed, so nothing was checked').toBeGreaterThan(0);
      for (const decision of printed) {
        expect(allowed, `an unrecorded decision reached the paper: ${decision}`)
          .toContain(decision);
      }
    }
  });
});
