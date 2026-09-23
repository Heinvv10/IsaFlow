/** Display formatting shared by the aging drill-down panels. */

export function fmtZar(amount: number): string {
  return new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(amount);
}

export function fmtDay(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-ZA');
}

export const PANEL_TH = 'px-4 py-2 text-[10px] tracking-[0.12em] font-semibold text-[var(--ff-text-secondary)] uppercase';
export const INVOICE_LINK = 'text-teal-500 hover:text-teal-400 hover:underline';
