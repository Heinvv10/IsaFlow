/**
 * What a downloaded pack is called. One implementation, because a company
 * that gets `acme-report-pack-board-....pdf` and `report-pack-board-....pptx`
 * out of the same screen has to guess which file is which.
 */

/** Lowercase, ASCII-only, dash-separated. Never throws on empty input. */
export function slugifyCompany(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function packDownloadFilename(
  companyName: string,
  packType: string,
  from: string,
  to: string,
  extension: 'pdf' | 'pptx',
): string {
  const slug = slugifyCompany(companyName) || 'company';
  return `${slug}-report-pack-${packType}-${from}-to-${to}.${extension}`;
}
