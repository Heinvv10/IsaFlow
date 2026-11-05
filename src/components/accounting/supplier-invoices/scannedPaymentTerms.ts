/**
 * The new-bill page's own "Payment Terms" option (immediate, net30, net60, net90) a scanned document's terms text
 * names, or null. Whole words only: "cod" is cash on delivery, not the inside of "decode" or "barcode", and `0 day`
 * must not match inside "30 days" / "60 days" / "90 days" (the page's inline version did, reading all three as immediate).
 */
export function scannedPaymentTermsOption(text: string): string | null {
  const pt = text.toLowerCase();
  if (/\bimmediate(ly)?\b/.test(pt) || /\bcod\b/.test(pt) || /(^|\D)0 days?\b/.test(pt)) return 'immediate';
  if (pt.includes('30')) return 'net30';
  if (pt.includes('60')) return 'net60';
  if (pt.includes('90')) return 'net90';
  return null;
}
