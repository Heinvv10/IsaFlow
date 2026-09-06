/**
 * HTML-escapes ledger-sourced text before it is interpolated into an ECharts
 * `tooltip.formatter` / `label.formatter` string, both of which render as
 * HTML. Local to `packs/` because WS1's equivalent
 * (`src/components/accounting/charts/chartTypes.ts`) is not on this branch
 * yet — the two will be unified after merge.
 */
const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (ch) => ESCAPES[ch] ?? ch);
}
