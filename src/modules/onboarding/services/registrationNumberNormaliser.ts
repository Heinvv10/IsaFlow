/**
 * South African CIPC registration number normaliser.
 *
 * VLMs often preserve the exact spacing of the printed document, so an
 * extracted reg number can come back as "2020 / 912495 / 07" or
 * "2020/ 912495 /07" instead of the canonical "2020/912495/07".
 *
 * This helper only touches strings that look like slash-delimited reg
 * numbers. Non-slash formats (older CK numbers, foreign registration IDs)
 * are returned trimmed but otherwise unchanged.
 */
export function normaliseRegistrationNumber(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || !trimmed.includes('/')) return trimmed;
  return trimmed.replace(/\s*\/\s*/g, '/');
}
