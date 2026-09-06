/**
 * ECharts renders a `tooltip.formatter` / `label.formatter` return string as
 * rich HTML, not text. Any ledger-sourced string (account name, step label,
 * node name) reaching one of those formatters unescaped is a stored-XSS
 * vector — an account named `<img src=x onerror=...>` executes in every
 * user's browser who hovers the chart. Escape before interpolation.
 *
 * Its own file rather than a passenger in `chartTypes.ts`: this is a
 * security boundary every option builder crosses, not a palette concern, and
 * a reader looking for the escaping should not have to know it lives inside
 * the colours module.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
