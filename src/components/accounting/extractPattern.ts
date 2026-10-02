/**
 * Strip unique references, dates, card numbers from a transaction description
 * to extract the recurring core pattern for rule matching.
 * Exported so other components (e.g. allocation flow) can derive the same pattern.
 */
export function extractPattern(desc: string): string {
  let p = desc;
  p = p.replace(/[a-f0-9]{8,}/gi, '');
  p = p.replace(/\d{4}[-/]\d{2}[-/]\d{2}/g, '');
  p = p.replace(/\d{2}[-/]\d{2}[-/]\d{4}/g, '');
  p = p.replace(/\d{8}/g, '');
  p = p.replace(/\d{4,}/g, '');
  p = p.replace(/\/Cmd\s+\w\b/gi, '');
  p = p.replace(/\s{2,}/g, ' ').trim();
  p = p.replace(/[/\s]+$/, '');
  return p;
}
