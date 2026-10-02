/**
 * THE INTEGRITY GATE'S REFUSAL, FOR ITS TWO READERS.
 *
 * `assertPackIntegrity` threw a plain `Error`, and the route that reports a
 * failed pack shows a person only a `PackRefusal`'s `userMessage` — anything
 * else is a 500 and one fixed sentence. So the refusal with the most to say to
 * the person who asked for the pack ("the balance sheet is out by R450") was
 * the one that told them nothing.
 *
 * The DIAGNOSTIC is every failure in full, as the gate has always worded
 * them: source paths, block ids, the lot. The READER'S sentence names which
 * check failed, once per check, in words that carry no identifier — and, for
 * the statement identities alone, the failure itself, because those sentences
 * were written for a director already and the gap in rands is the one number
 * they can chase.
 */
import { PackRefusal } from '../packRefusal';

/** Each check the gate runs, by what it holds the document to. */
export type IntegrityCheck =
  | 'consistency'
  | 'resolution'
  | 'statements'
  | 'quotients'
  | 'cashBridge'
  | 'comparative'
  | 'prose'
  | 'scale'
  | 'matters'
  | 'columns'
  | 'chartClaims'
  | 'waterfall';

export interface IntegrityFailure {
  check: IntegrityCheck;
  /** The engineer's sentence — everything, identifiers included. */
  message: string;
}

/** What each check's failure means to the person who asked for the pack. A
 *  `Record` over the union, so a new check cannot be added without one. */
const READER: Record<IntegrityCheck, string> = {
  consistency: 'One figure is stated at two different values in different places of the pack.',
  resolution: 'A figure printed on a page is not the figure the pack recorded for it.',
  statements: 'The statements do not add up.',
  quotients: 'A percentage in the pack is not the percentage its two figures give.',
  cashBridge: 'The cash bridge does not open and close on the balances the cash statement prints.',
  comparative: 'The comparative period the pack states is not the one its statements compare against.',
  prose: 'A sentence in the pack carries wording that was not written for a reader.',
  scale: 'The pack states its figures at a scale it cannot print them in.',
  matters: 'The board action panel and the matters page do not agree about the matters they list or count.',
  columns: 'A statement column does not hold what its heading says.',
  chartClaims: 'A chart and the table on its page state one figure at two values.',
  waterfall: 'A bridge chart does not add up, or leaves a large unexplained step without saying so.',
};

/**
 * A dotted path — `packFigureSet.current.totalAssets` — which is what every
 * internal name in a failure message looks like and what no sentence does: a
 * full stop is followed by a space, and a decimal point by a digit.
 */
const DOTTED_PATH = /[A-Za-z]\.[A-Za-z]/;

/** The statement failures a reader is shown in full: the ones that name
 *  figures the way the statement does. One that names a source is not. */
function statementDetail(failures: readonly IntegrityFailure[]): string[] {
  return failures
    .filter((failure) => failure.check === 'statements' && !DOTTED_PATH.test(failure.message))
    .map((failure) => failure.message);
}

export function integrityRefusal(failures: readonly IntegrityFailure[]): PackRefusal {
  const diagnostic =
    'Pack figure integrity failed, so this render is refused (spec §7.2). '
    + `${failures.length} problem${failures.length === 1 ? '' : 's'}:\n  `
    + failures.map((failure) => failure.message).join('\n  ');

  const checks = [...new Set(failures.map((failure) => failure.check))];
  const user = [
    'This pack has not been produced, because it failed a check it runs on itself before printing.',
    ...checks.map((check) => READER[check]),
    ...statementDetail(failures),
    'Nothing has been left out or adjusted to hide this. Please contact support with the period you asked for.',
  ].join(' ');

  return new PackRefusal(diagnostic, user);
}
