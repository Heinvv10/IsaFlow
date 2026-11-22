/** The few lines a person reads at the end of a run; the full report is the JSON file. PURE. */
import { formatCents } from '@/lib/money/formatMoney';
import type { MigrationReport, PhaseReport } from './sageMigrationTypes';

const money = formatCents;
/** The console shows the start of a tool's refusal; the JSON report keeps all of it. */
export const CONSOLE_ERROR_CHARS = 600;
const shown = (text: string | null): string =>
  text === null || text.length <= CONSOLE_ERROR_CHARS ? String(text) : `${text.slice(0, CONSOLE_ERROR_CHARS)} ... (${text.length} characters; the whole text is in the report file)`;
const phase = (name: string, p: PhaseReport | undefined): string =>
  p ? `${name}: ${p.batches.length} batches, ${p.failed} failed` : `${name}: not run`;

export function summaryLines(r: MigrationReport): string[] {
  const rec = r.reconciliation;
  const po = rec.purchaseOrders;
  const lines = [
    `company ${r.companyId}: ${r.status}`,
    `items: ${rec.items.inExport} in export, ${rec.items.refused} refused, ${rec.items.sent} sent, ${rec.items.presentBefore} already there, ${rec.items.presentAfter} there after (+${rec.items.addedByRun})`,
    `purchase orders: ${po.inExport} in export, ${po.refused} refused, ${po.sent} sent, ${po.presentBefore} already there, ${po.presentAfter} there after (+${po.addedByRun})`,
    `PO total: export ${money(po.exportTotalCents)}, sent ${money(po.sentTotalCents)}, not sent ${money(po.notSentTotalCents)}, booked ${money(po.bookedTotalCents)}, difference ${money(po.differenceCents)}`,
    `stock movements written: ${rec.stock.written} (${rec.stock.itemsWithQuantityOnHandIgnored} items carried a QuantityOnHand, ignored)`,
    `PDFs to attach: ${rec.attachments.posWithPdf} (the runner uploads none)`,
    `dry run: ${phase('categories', r.dryRun.categories)}; ${phase('items', r.dryRun.items)}; ${phase('purchase orders', r.dryRun.purchaseOrders)}`,
  ];
  if (r.live) lines.push(`live: ${phase('categories', r.live.categories)}; ${phase('items', r.live.items)}; ${phase('purchase orders', r.live.purchaseOrders)}`);
  for (const [name, e] of Object.entries(rec.expected)) if (e && !e.ok) lines.push(`MISMATCH ${name}: expected ${e.expected}, export has ${e.actual}`);
  for (const x of r.refused.slice(0, 20)) lines.push(`refused ${x.entity} ${x.label} [${x.code}]: ${x.reasons.join('; ')}`);
  if (r.refused.length > 20) lines.push(`... and ${r.refused.length - 20} more refused rows (see the report file)`);
  for (const p of [r.live, r.dryRun]) {
    for (const b of p ? [...p.categories.batches, ...p.items.batches, ...p.purchaseOrders.batches] : []) {
      if (b.status === 'failed') lines.push(`FAILED ${b.entity} batch ${b.n}${p === r.dryRun ? ' (dry run)' : ''}: ${shown(b.error)}`);
    }
  }
  if (r.live) lines.push(`complete: ${rec.complete}`);
  return lines;
}
