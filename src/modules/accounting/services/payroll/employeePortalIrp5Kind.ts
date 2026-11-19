/**
 * The one label for an EMP501 reconciliation's kind (wave 6 SS-c), used by the portal's IRP5 section and its PDF copy.
 * Its own module, with no imports, so the browser bundle takes it without the PDF builder's server-side imports.
 */
export const kindLabel = (kind: 'interim' | 'annual'): string =>
  (kind === 'annual' ? 'Annual (March to February)' : 'Interim (March to August)');
