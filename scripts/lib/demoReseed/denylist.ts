/**
 * Names the Demo company must never show again: real South African companies
 * (the old seeder's customers and suppliers, telecoms and banks) and the QA
 * artefacts left behind by manual testing. Used by the unit test over every
 * generated string and by post-check N1/N2 over the database.
 */

/** Matched as whole words on normalised text (lower case, punctuation as spaces). */
export const REAL_NAME_DENYLIST: readonly string[] = [
  'eskom', 'openserve', 'dfa', 'dark fibre africa', 'herotel', 'metrofibre', 'frogfoot', 'vumatel',
  'linkafrica', 'link africa', 'bidvest', 'velocityfibre', 'velocity fibre', 'makro', 'builders warehouse',
  'telkom', 'engen', 'office national', 'vodacom', 'city of jhb', 'city of johannesburg', 'sage', 'sage sa',
  'karabina', 'cape office supplies', 'fnb', 'first national bank', 'absa', 'standard bank', 'nedbank',
  'capitec', 'investec', 'mtn', 'cell c', 'shoprite', 'pick n pay', 'takealot',
  'koenig solutions', 'unisa', 'edge learning media', 'usb executive development',
];

/** Matched as substrings of the lower-cased raw text (they carry punctuation). */
export const QA_ARTEFACT_DENYLIST: readonly string[] = [
  '0gp-golden', '0gp golden', 'qa demo claim', 'phase 10 e2e retest', 'demo ux practice client',
  'qa demo mailbox', '[merged]', 'qa fraud', 'audit-0704', 'stresstest', 'qa test customer', 'qa test supplier',
  'p5 acceptance supplier', 'e2e test customer', 'loop test',
];

export function normalise(text: string): string {
  return ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
}

/** Every denylisted term found in `text` (empty when clean). */
export function findDeniedNames(text: string): string[] {
  const norm = normalise(text);
  const raw = text.toLowerCase();
  const hits = REAL_NAME_DENYLIST.filter((t) => norm.includes(` ${t} `));
  for (const t of QA_ARTEFACT_DENYLIST) if (raw.includes(t)) hits.push(t);
  return hits;
}

/** A full ISO-style date in text (the golden money spec fails on one). */
export const ISO_DATE_IN_TEXT = /\d{4}[/-]\d{2}[/-]\d{2}/;
