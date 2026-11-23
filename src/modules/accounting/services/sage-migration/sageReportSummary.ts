/** The few lines a person reads at the end of a run; the full report is the JSON file. PURE. */
import { formatCents } from '@/lib/money/formatMoney';
import type { MigrationReport, PhaseReport } from './sageMigrationTypes';

const money = formatCents;
/** The console shows the start of a tool's refusal; the JSON report keeps all of it. */
export const CONSOLE_ERROR_CHARS = 600;
const shown = (text: string | null): string =>
  text === null || text.length <= CONSOLE_ERROR_CHARS ? String(text) : `${text.slice(0, CONSOLE_ERROR_CHARS)} ... (${text.length} characters; the whole text is in the report file)`;
const phase = (name: string, p: PhaseReport | undefined): string =>
  p && !p.skipped ? `${name}: ${p.batches.length} batches, ${p.failed} failed` : `${name}: not run`;

export function summaryLines(r: MigrationReport): string[] {
  const rec = r.reconciliation;
  const po = rec.purchaseOrders;
  const lines = [
    `company ${r.companyId}: ${r.status}`,
    `items: ${rec.items.inExport} in export, ${rec.items.refused} refused, ${rec.items.sent} sent, ${rec.items.presentBefore} already there, ${rec.items.presentAfter} there after (+${rec.items.addedByRun})`,
    `purchase orders: ${po.inExport} in export, ${po.refused} refused, ${po.sent} sent, ${po.presentBefore} already there, ${po.presentAfter} there after (+${po.addedByRun})`,
    `PO total: export ${money(po.exportTotalCents)}, sent ${money(po.sentTotalCents)}, not sent ${money(po.notSentTotalCents)}, ${r.live === null ? 'booked n/a (dry run), difference n/a' : `booked ${money(po.bookedTotalCents)}, difference ${money(po.differenceCents)}`}`,
    ...(po.exportRowsWithoutTotal > 0 ? [`WARNING: the export PO total leaves out ${po.exportRowsWithoutTotal} row(s) whose Total is not a number`] : []),
    `stock movements written: ${rec.stock.written} (${rec.stock.itemsWithQuantityOnHandIgnored} items carried a QuantityOnHand, ignored)`,
    `PDFs to attach: ${rec.attachments.posWithPdf} (the runner uploads none)`,
    `dry run: ${phase('categories', r.dryRun.categories)}; ${phase('items', r.dryRun.items)}; ${phase('purchase orders', r.dryRun.purchaseOrders)}`,
  ];
  if (r.live) lines.push(`live: ${phase('categories', r.live.categories)}; ${phase('items', r.live.items)}; ${phase('purchase orders', r.live.purchaseOrders)}`);
  if (!rec.nothingRefused && rec.items.sent + po.sent === 0) lines.push('WARNING: every row was refused: nothing is imported');
  for (const why of r.liveBlockedBy) lines.push(`LIVE NOT STARTED: ${why}`);
  if (r.budgetWouldHaveFailed.length > 0) {
    lines.push(`BUDGET: ${r.budgetWouldHaveFailed.length} purchase order(s) would have failed the budget check (skipped by --skip-budget-check):`);
    for (const x of r.budgetWouldHaveFailed) lines.push(`  ${x.poNumber}: ${x.reasons.join('; ') || 'no reason given'}`);
  }
  const ll = r.lineLinks;
  lines.push(`PO lines linked to their item: ${ll.linked} (${ll.basis === 'booked' ? 'counted in the books' : 'planned: nothing is written by a dry run'}); not linked: ${ll.notLinked.length}`);
  for (const n of ll.notLinked.slice(0, 20)) lines.push(`  line not linked: item ${n.reason}: ${n.poNumber} line ${n.line} (${n.itemCode}), sent with " [item ${n.itemCode}]" in its description`);
  if (ll.notLinked.length > 20) lines.push(`  ... and ${ll.notLinked.length - 20} more not-linked lines (see the report file)`);
  if (ll.alreadyThere.length > 0) lines.push(`  ${ll.alreadyThere.length} PO(s) were already there and are not changed: their lines are not counted above`);
  if (ll.notLinked.length > 0) lines.push('  not linked lines are informational: they do not change the exit code (the item code stays readable in the description)');
  for (const p of r.differences.purchaseOrders) {
    lines.push(`DIFFERS: ${p.poNumber} is already in IsaFlow with other figures than Sage (the stored PO is not changed): ${p.differences.map((d) => `${d.field} ${String(d.existing)} -> ${String(d.requested)}`).join('; ') || 'no detail given'}`);
  }
  for (const c of r.differences.categories) lines.push(`DIFFERS: category ${c.name} would be updated to Sage's values: ${c.changed.join(', ') || 'no detail given'}`);
  for (const i of r.differences.items) lines.push(`DIFFERS: item ${i.code} would be updated to Sage's values: ${i.changed.join(', ') || 'no detail given'}`);
  if (rec.items.presentBefore > 0) {
    lines.push('NOTE: a re-run sets the items and categories this migration owns back to the values it sends; edits to those fields in IsaFlow since the import are overwritten (a value Sage dropped stays: the tools never clear a field).');
  }
  for (const [name, e] of Object.entries(rec.expected)) {
    if (!e || e.ok) continue;
    const fig = (n: number): string => (name === 'purchaseOrderTotalCents' ? money(n) : String(n));
    lines.push(`MISMATCH ${name}: expected ${fig(e.expected)}, ${e.basis} ${fig(e.actual)}`);
  }
  for (const x of r.refused.slice(0, 20)) lines.push(`refused ${x.entity} ${x.label} [${x.code}]: ${x.reasons.join('; ')}`);
  if (r.refused.length > 20) lines.push(`... and ${r.refused.length - 20} more refused rows (see the report file)`);
  for (const p of [r.live, r.dryRun]) {
    for (const b of p ? [...p.categories.batches, ...p.items.batches, ...p.purchaseOrders.batches] : []) {
      if (b.status === 'failed') lines.push(`FAILED ${b.entity} batch ${b.n}${p === r.dryRun ? ' (dry run)' : ''}: ${shown(b.error)}`);
      if (b.commitUnconfirmed) lines.push(`COMMIT UNCONFIRMED: ${b.entity} batch ${b.n} (${b.key}): it may have been committed; check the books`);
    }
  }
  lines.push(`all sent rows booked: ${rec.allSentBooked}; nothing refused: ${rec.nothingRefused}`);
  return lines;
}

/**
 * 0: a clean dry run, or a live run that booked every row it sent, and every --expect-* figure matched what was sent / booked, and
 * no row was refused (unless `allowRefusals`), and no PO or owned item differs from what the books hold (unless `allowDifferences`). 1: anything else.
 * 4: a live batch's COMMIT did not answer (`commitUnconfirmed`): the books may hold it, so the run is not just "not ok" (same meaning as a stop after the live phase started).
 */
export function exitCodeFor(r: MigrationReport, allowRefusals: boolean, allowDifferences = false): 0 | 1 | 4 {
  const rec = r.reconciliation;
  const live = r.live ? [...r.live.categories.batches, ...r.live.items.batches, ...r.live.purchaseOrders.batches] : [];
  if (live.some((b) => b.commitUnconfirmed)) return 4;
  const finished = r.status === 'dry_run_ok' || (r.status === 'completed' && rec.allSentBooked);
  const expectationsMet = Object.values(rec.expected).every((e) => e === null || e.ok);
  const differs = r.differences.purchaseOrders.length + r.differences.items.length + r.differences.categories.length > 0;
  return finished && expectationsMet && (rec.nothingRefused || allowRefusals) && (!differs || allowDifferences) ? 0 : 1;
}
