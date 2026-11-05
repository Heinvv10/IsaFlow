// `0 day` must not match inside "30 days" / "60 days" / "90 days" (the page's inline version did, reading them all as immediate).
/** The new-bill page's own "Payment Terms" option (immediate, net30, net60, net90) a scanned document's terms text names, or null. */
export function scannedPaymentTermsOption(text: string): string | null {
  const pt = text.toLowerCase();
  if (pt.includes('immediate') || pt.includes('cod') || /(^|\D)0 day/.test(pt)) return 'immediate';
  if (pt.includes('30')) return 'net30';
  if (pt.includes('60')) return 'net60';
  if (pt.includes('90')) return 'net90';
  return null;
}
