/**
 * Saves of an invoice still out from this browser tab, by invoice id (PR S). The edit page's last change is sent as the
 * page closes (Back, a link), so the next page can read the invoice before that PUT lands and show, or approve, what
 * is no longer stored. Every page that reads an invoice to show it waits here first, a bounded while: a save that never
 * answers must not hold a page.
 *
 * A save sent as a page left (`leaving`) has no page left to say it failed: its failure is recorded per invoice, and
 * the next page that reads that invoice says so once (`takeUnsavedLeave`). Any later save of it that lands clears it.
 */

const pending = new Map<string, Set<Promise<unknown>>>();
const unsavedLeaves = new Set<string>();

export const PENDING_SAVE_WAIT_MS = 5000;

export function trackInvoiceSave(invoiceId: string, save: Promise<unknown>, opts: { leaving?: boolean } = {}): void {
  const set = pending.get(invoiceId) ?? new Set<Promise<unknown>>();
  set.add(save);
  pending.set(invoiceId, set);
  const done = () => {
    set.delete(save);
    if (set.size === 0 && pending.get(invoiceId) === set) pending.delete(invoiceId);
  };
  save.then(() => { unsavedLeaves.delete(invoiceId); done(); }, () => { if (opts.leaving) unsavedLeaves.add(invoiceId); done(); });
}

/**
 * Once, for the page reading `invoiceId` after its saves settled: a change sent as a page left that did not land. A
 * refusal-shaped value, so the edit page shows it where it shows a carried refusal.
 */
export function takeUnsavedLeave(invoiceId: string, invoiceNumber: string): { message: string; status: null } | null {
  if (!unsavedLeaves.delete(invoiceId)) return null;
  return { message: `Your last change to ${invoiceNumber} was not saved — it is shown as stored.`, status: null };
}

/**
 * Resolves once every save of `invoiceId` out now has answered, or after `maxMs`, whichever is first. A save still
 * unanswered by then is waited for no more: it is dropped from the map, so no later page waits on it again.
 */
export async function invoiceSavesSettled(invoiceId: string, maxMs = PENDING_SAVE_WAIT_MS): Promise<void> {
  const saves = [...(pending.get(invoiceId) ?? [])];
  if (saves.length === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = await Promise.race([
    Promise.allSettled(saves).then(() => false),
    new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), maxMs); }),
  ]);
  clearTimeout(timer);
  if (!timedOut) return;
  const set = pending.get(invoiceId);
  for (const save of saves) set?.delete(save);
  if (set && set.size === 0) pending.delete(invoiceId);
}
