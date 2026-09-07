/**
 * THE PACK MUST NOT PRINT ITS OWN PLUMBING.
 *
 * Six separate defects on the rendered proofs turned out to be one thing:
 *
 *   - page 12, caveat 1: "Set `account_subtype` to 'inventory' on the stock
 *     control account" — a database column name and an instruction to a system
 *     administrator, in a document going to a board. It came back as
 *     "classify the stock control account for one", the same instruction with
 *     the column name taken out, which is why there is now a rule about the
 *     INSTRUCTION as well as one about the column;
 *   - Brightsphere page 10: "Why — Spec §4.A asks for 6 panels and 4 are
 *     drawn" — a clause number from this project's own specification, quoted
 *     to directors;
 *   - pages 4 and 11: "is 739 day(s) overdue", twice per sheet;
 *   - page 11: "12 unreconciled bank item(s) across 3 account(s)";
 *   - page 12: `Extracted at 2026-09-07T06:22:04.572Z`;
 *   - Brightsphere page 10: "Revenue rose from – to – over 12 periods".
 *
 * Every one of them was written by someone describing a MECHANISM to another
 * developer — why a panel is missing, which field to set, how many of a thing
 * there might be — at a moment when the data was awkward. The pack's ordinary
 * prose is fine; it is the ABSENCE-EXPLANATION and CAVEAT paths, the ones a
 * flattering fixture never reaches, where the voice slips. Fixing six strings
 * leaves the seventh to the next company whose ledger is untidy.
 *
 * So this is a gate, and it THROWS, for the reason `assertPackIntegrity`
 * throws: a warning about a board pack lands in a log the author has stopped
 * reading while the pack goes out with the defect in it. It runs on the
 * COMPOSED document — the artefact a director receives — so a leak introduced
 * anywhere upstream, in a service this file has never heard of, still fails
 * the render.
 *
 * WHAT IT DOES NOT READ, AND WHY. Two fields carry text a PERSON typed: the
 * company's own name, and the matters page's issue/decision columns, which
 * interpolate journal descriptions, entity names and filing types straight
 * out of a company's ledger. A gate over those would refuse to render a board
 * pack because a bookkeeper named a journal "Item(s) received" — a worse
 * failure than the leak it would catch, and one the customer cannot fix in
 * time for the meeting. The matters templates are pack-authored and are held
 * to the same standard by `packMatters.test.ts`, at the source, where the
 * template and the ledger value are still separable.
 */
import type { PackPagesDocument } from '../pages/packPageModel';

/** One string the pack composed, and where a reader meets it. */
interface Located {
  text: string;
  where: string;
}

interface Rule {
  /** What a failure message calls it. */
  name: string;
  pattern: RegExp;
  /** What the author should write instead. */
  instead: string;
}

const RULES: Rule[] = [
  {
    name: 'an internal specification reference',
    // `§` at all: this pack cites no legislation by section, and the one
    // place a section mark appeared it was quoting our own spec to a board.
    pattern: /§|\bR-P\d+\b|\bcriterion \d+\b/,
    instead:
      'state the requirement in the reader\'s terms — what the pack carries and what this '
      + 'company\'s ledger could not support — never which clause asks for it',
  },
  {
    name: 'a schema identifier',
    // snake_case, which in this codebase is always a column, a table or a
    // subtype constant. Ordinary English does not produce it.
    pattern: /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/,
    instead: 'name the thing in business words — "the stock control account", not the column',
  },
  {
    name: 'a camelCase identifier',
    // A function, field or type name that escaped a template.
    pattern: /\b[a-z]+[A-Z][A-Za-z]*\b/,
    instead: 'name the thing in business words',
  },
  {
    name: "a developer's plural",
    pattern: /\(s\)/,
    instead: 'the model knows the count — write "1 account" or "3 accounts"',
  },
  {
    name: 'a machine timestamp',
    pattern: /\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}|\b)/,
    instead: 'a date in words, on the company\'s clock — see `formatPackTimestamp`',
  },
  {
    name: 'a zero glyph where a figure belongs',
    // The table's en dash, dropped into a sentence after a preposition:
    // "rose from – to –". A figure position in prose takes a word.
    pattern: /\b(?:from|to|of|at|is|by)\s+–(?=\s|[.,;)]|$)/,
    instead: 'put the figure in the sentence with `inProse`, which says "nil"',
  },
  {
    name: 'a remedy addressed to an operator',
    /**
     * A LEDGER INSTRUCTION, IN A DOCUMENT NOBODY WHO CAN ACT ON IT READS.
     *
     * Page 12's inventory caveat has now carried two of these. "Set
     * `account_subtype` to 'inventory' on the stock control account" was
     * caught by the schema rule above — not because it was an instruction,
     * but because it named a column; reworded to "classify the stock control
     * account for one" it says the same thing in business words and sailed
     * through every rule here. The guard was matching the vocabulary the
     * defect happened to use rather than the defect.
     *
     * CLAUSE-INITIAL AND A CLOSED VOCABULARY, both deliberate. English
     * imperatives are not decidable by regex, and a rule that tried would
     * refuse a board pack over an ordinary sentence — a worse failure than
     * the leak, and one nobody can fix before the meeting. These are the
     * verbs by which a pack tells someone to go and change the books, and
     * they are only an instruction in the position an instruction takes:
     * "classify …" is one, "no account is classified as inventory" is the
     * disclosure the pack is supposed to make instead.
     */
    pattern: /(?:^|[.;:]\s+|—\s+)(?:classify|reclassify|recapture|capture|configure|enable|assign|tag|map|set up|switch on|turn on|contact)\b/i,
    instead:
      'state what the reader is missing and what they are reading instead — a board cannot '
      + 'act on a ledger instruction, and the person who can is not holding this document',
  },
  {
    name: 'a unit shoved against a figure instead of heading its column',
    /**
     * `R'000` IS A BANNER, NOT A SUFFIX.
     *
     * Every statement in the pack sets its scale once, above the column it
     * governs, and every sentence that names the scale says it with the
     * preposition — "Figures in R'000". Two sentences did neither and wrote
     * the banner token immediately after a figure instead: page 11's "3 544
     * R'000 of exposure" and page 10's "a span of 3 529 R'000". That is a
     * third position for the unit in one document, and a reader who has to
     * work out where the unit sits has to work out whether it applies.
     *
     * The digit-space-token shape is the whole defect: the banner itself is
     * a bare `R'000` with nothing before it and is collected by this gate
     * (`table scale`) without matching, and `inScale` puts a comma and the
     * preposition between the two.
     */
    pattern: /\d\s+R(?:'000|'m)?(?=[\s.,;:)]|$)/,
    instead: 'say it the way the rest of the pack does — `inScale`, which writes ", in R\'000"',
  },
  {
    name: 'a placeholder or a runtime sentinel',
    pattern: /\b(?:TODO|FIXME|XXX|undefined|NaN|\[object Object\])\b/,
    instead: 'a sentence the pack can stand behind, or no sentence',
  },
];

/**
 * Every string the pack COMPOSED and prints, with where a reader meets it.
 *
 * Deliberately exhaustive over the block union rather than over the two or
 * three kinds that happened to leak: the next leak is in whichever kind this
 * list forgets. Ledger-sourced fields are the documented exceptions above.
 */
function locateProse(doc: PackPagesDocument): Located[] {
  const found: Located[] = [];
  const push = (where: string, ...texts: Array<string | null | undefined>): void => {
    for (const text of texts) if (text !== null && text !== undefined && text !== '') found.push({ text, where });
  };

  const basis = doc.basisOfPreparation;
  push('the basis of preparation', basis.standard, basis.sourceSystem, basis.extractedAt, basis.ledgerVersion);

  for (const page of doc.pages) {
    const at = (what: string): string => `page ${page.number} ${what}`;
    push(at('title'), page.title);
    push(at('contents entry'), page.navLabel);
    for (const footnote of page.footnotes) push(at(`footnote ${footnote.number}`), footnote.text);

    for (const block of page.blocks) {
      switch (block.kind) {
        case 'kpiTiles':
          for (const tile of block.tiles) push(at(`tile '${tile.label}'`), tile.label, tile.figure.unavailable, tile.delta?.basis);
          break;
        case 'statTiles':
          for (const group of block.groups) {
            push(at('stat group'), group.heading);
            for (const stat of group.stats) push(at(`stat '${stat.label}'`), stat.label, stat.figure.unavailable);
          }
          break;
        case 'table':
          push(at('table scale'), block.table.scale);
          for (const row of block.table.rows) {
            push(at(`table row '${row.label}'`), row.label);
            for (const figure of Object.values(row.figures)) push(at(`table row '${row.label}'`), figure?.unavailable);
          }
          break;
        case 'scorecard':
          for (const group of block.groups) {
            push(at('scorecard group'), group.name);
            for (const row of group.rows) {
              push(at(`scorecard '${row.metric}'`), row.metric, row.actual.unavailable, row.prior?.unavailable);
            }
          }
          break;
        case 'chart':
          push(at(`chart '${block.chart.id}'`), block.chart.title);
          for (const bar of block.chart.waterfallBars ?? []) push(at(`chart '${block.chart.id}' bar`), bar.label);
          break;
        case 'smallMultiples':
          for (const panel of block.panels) push(at(`panel '${panel.id}'`), panel.title);
          break;
        case 'narrative':
          // A DERIVED body is the pack's own words; an APPROVED one is a
          // person's, and the pack does not get to refuse to print what its
          // board signed. `boardActions` restate the matters page's
          // ledger-sourced text and are excluded with it.
          if (block.narrative.status !== 'approved') push(at('commentary'), block.narrative.body);
          break;
        case 'matters':
          // The issue and decision columns carry ledger text — see the file
          // header. The block's own summary of what did not fit does not.
          push(at('matters omission note'), block.omitted?.quantum.unavailable);
          break;
        case 'disclosure':
          push(at(`disclosure '${block.disclosure.heading}'`), block.disclosure.heading);
          for (const note of block.disclosure.notes) {
            push(at(`disclosure '${block.disclosure.heading}'`), note.heading, note.body);
          }
          break;
        case 'definitions':
          for (const entry of block.entries) {
            push(at(`definition '${entry.term}'`), entry.term, entry.definition);
            for (const step of entry.reconciliation ?? []) push(at(`definition '${entry.term}'`), step.label);
          }
          break;
      }
    }
  }
  return found;
}

/**
 * Refuse a pack that prints a spec reference, a schema or code identifier, a
 * developer's plural, a machine timestamp, a table glyph in a sentence, a
 * remedy addressed to whoever maintains the ledger, or a runtime sentinel.
 *
 * Reports every failure rather than the first, for the same reason the figure
 * gate does: prose that has slipped has usually slipped in more than one
 * place, and one per fix-and-rerun cycle wastes the author's day.
 */
export function checkProse(doc: PackPagesDocument): string[] {
  const failures: string[] = [];
  for (const { text, where } of locateProse(doc)) {
    for (const rule of RULES) {
      const hit = rule.pattern.exec(text);
      if (hit === null) continue;
      failures.push(
        `${where} prints ${rule.name} — "${hit[0]}" — in "${text.slice(0, 120)}". `
          + `A board pack does not show a reader how it is built: ${rule.instead}.`,
      );
    }
  }
  return failures;
}
