/**
 * The prose the merge preview carries.
 *
 * It lives apart from the assembly because this is the part a PERSON reads: the
 * response has to explain what an unchanged trial balance does and does not
 * prove without the reader ever seeing this repository. Keeping it here also
 * takes three long constants off `accountMergePreview.ts`, which was sitting one
 * line under the 300-line cap.
 */
export const CAVEAT = [
  'The company totals are unchanged BY CONSTRUCTION — a repoint alters no debit and no credit,',
  'only which account carries it — so "unchanged: true" on its own proves nothing.',
  'The part that can fail is the identity: the other accounts, the source and the target are',
  'counted by three separate queries and must sum to a fourth, company-wide one. That check is',
  'NECESSARY AND NOT SUFFICIENT: two offsetting errors satisfy it exactly, and the cleaner it',
  'looks the more it invites being trusted without inspection. Open the entries.',
].join(' ');

export const SYSTEM_NOTE = [
  'Auto-posting resolves a system account by its SUBTYPE, not by its code or name',
  '(systemAccountResolver), and its cache only loads accounts that are active. A system source is',
  'therefore refused outright: deactivating it leaves the role unclaimed and every automatic',
  'journal starts throwing. Where more than one active system account claims a subtype the',
  'resolver picks deterministically and logs — targetSubtypeClaimants lists them, so you can see',
  'whether this merge is moving money into a role that is already contested.',
].join(' ');

export const CLASS_NOTE = [
  'A merge may not cross reporting classes. `vat` covers the subtypes the VAT201 selects on',
  '(vat_input, vat_output, tax); `bank` is the subtype every banking screen reaches statement',
  'rows through; everything else, NULL included, is `ordinary` presentation grouping inside a',
  'side of the balance sheet that account_type already pins. Both intended control-account',
  'merges are ordinary to ordinary.',
].join(' ');
