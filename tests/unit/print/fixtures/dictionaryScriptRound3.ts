/**
 * THE ROUND-3 ADVERSARY'S PATTERNS (#1263): a dictionary-script run glued to a Latin word, a base outside the span with
 * its mark inside, repeated spacing marks, Lao U+0ECE, and the Burmese and Thai prose with English glued in
 * (`/home/hein/audit-archive/p3fu/reviews-1263-r3/adv-work/p4*`), as patterns to repeat.
 */
export const ROUND3_PATTERNS: ReadonlyArray<readonly [string, string]> = [
  ['myanmar+latin30', '\u1000\u102F\u1019\u1039BankReconciliationStatementAdj'],
  ['lao+latin30', '\u0EAA\u0EB0\u0E9E\u0EB2BankReconciliationStatementAdj'],
  ['thai+latin30', '\u0E23\u0E32\u0E22\u0E44BankReconciliationStatementAdj'],
  ['myanmar+latin50', '\u1000\u102F\u1019\u1039BankReconciliationStatementAdjustmentsForTheQuarte'],
  ['khmer+latin30', '\u1780\u17B6\u179A\u1780BankReconciliationStatementAdj'],
  ['thai+english', '\u0E23\u0E32\u0E22\u0E44\u0E14\u0E49\u0E08\u0E32\u0E01\u0E01\u0E32\u0E23\u0E02\u0E32\u0E22FibreInstallation\u0E40\u0E1E\u0E34\u0E48\u0E21\u0E02\u0E36\u0E49\u0E19\u0E40\u0E21\u0E37\u0E48\u0E2D\u0E40\u0E17\u0E35\u0E22\u0E1A\u0E01\u0E31\u0E1AQuarter\u0E01\u0E48\u0E2D\u0E19\u0E2B\u0E19\u0E49\u0E32\u0E42\u0E14\u0E22Reconciliation\u0E40\u0E2A\u0E23\u0E47\u0E08\u0E41\u0E25\u0E49\u0E27'],
  ['m+myanmarAA', 'm\u102C'],
  ['x+khmerAA', 'x\u17B6'],
  ['lao+yamakkan', '\u0E81\u0ECE'],
  ['thai(latin)', '\u0E23\u0E32\u0E22\u0E44\u0E14\u0E49(BankReconciliationStatement)'],
  ['thai4(latin)', '\u0E23\u0E32\u0E22\u0E44(BankReconciliationStatementAdj)'],
  ['myanmar-e1', '\u1000\u102F\u1014\u103A\u1000\u103B\u1005\u101B\u102D\u1010\u103A\u1001\u103D\u1032\u1040\u1031\u1019\u103E\u102F'],
  ['myanmar-e2', '\u1000\u102F\u1014\u103A\u1000\u103B\u1005\u101B\u102D\u1010\u103A\u1001\u103D\u1032\u1040\u1031\u1019\u103E\u102F\u1000\u102D\u102F\u1005\u1005\u103A\u1006\u1031\u1038\u1015\u103C\u102E\u1038\u104B '],
  ['myanmar-zero+i', '\u1040\u102D'],
  ['myanmar-zero-word', '\u1001\u103D\u1032\u1040\u1031'],
  ['khmer+aa31', '\u1780\u17B6\u17B6\u17B6\u17B6\u17B6\u17B6\u17B6\u17B6\u17B6\u17B6\u17B6\u17B6\u17B6\u17B6\u17B6\u17B6\u17B6\u17B6\u17B6\u17B6\u17B6\u17B6\u17B6\u17B6\u17B6\u17B6\u17B6\u17B6\u17B6\u17B6\u17B6 '],
  ['khmer+aa32', '\u1780\u17B6\u17B6\u17B6\u17B6\u17B6\u17B6\u17B6\u17B6\u17B6\u17B6\u17B6\u17B6\u17B6\u17B6\u17B6\u17B6\u17B6\u17B6\u17B6\u17B6\u17B6\u17B6\u17B6\u17B6\u17B6\u17B6\u17B6\u17B6\u17B6\u17B6\u17B6\u17B6 '],
  ['myanmar+tall-aa', '\u1000\u102B\u102B\u102B\u102B\u102B\u102B\u102B\u102B\u102B\u102B\u102B\u102B\u102B\u102B\u102B\u102B\u102B\u102B\u102B\u102B\u102B\u102B\u102B\u102B\u102B\u102B\u102B\u102B\u102B\u102B\u102B '],
  ['khmer+aa3', '\u1780\u17B6\u17B6\u17B6'],
  ['round3-p4-5', '\u1000\u102F\u1019\u1039\u1015\u100F\u102E\u104F\u1004\u103D\u1031\u1000\u103C\u1031\u1038\u1021\u1001\u103C\u1031\u1021\u1014\u1031\u101E\u100A\u103ABankReconciliationStatement'],
  ['round3-p4-8', '\u0E23\u0E32\u0E22\u0E44\u0E14\u0E49\u0E02\u0E2D\u0E07\u0E1A\u0E23\u0E34\u0E29\u0E31\u0E172026Q3RevenueGrowth'],
];
