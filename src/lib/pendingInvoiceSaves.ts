/**
 * Saves of an invoice still out from this browser tab, by invoice id (PR S). The edit page's last change is sent as the
 * page closes (Back, a link), so the next page can read the invoice before that PUT lands and show, or approve, what
 * is no longer stored. Every page that reads an invoice to show it waits here first, a bounded while: a save that never
 * answers must not hold a page.
 */

const pending = new Map<string, Set<Promise<unknown>>>();

export const PENDING_SAVE_WAIT_MS = 5000;

export function trackInvoiceSave(invoiceId: string, save: Promise<unknown>): void {
  const set = pending.get(invoiceId) ?? new Set<Promise<unknown>>();
  set.add(save);
  pending.set(invoiceId, set);
  const done = () => {
    set.delete(save);
    if (set.size === 0 && pending.get(invoiceId) === set) pending.delete(invoiceId);
  };
  save.then(done, done);
}

/** Resolves once every save of `invoiceId` out now has answered, or after `maxMs`, whichever is first. */
export async function invoiceSavesSettled(invoiceId: string, maxMs = PENDING_SAVE_WAIT_MS): Promise<void> {
  const saves = [...(pending.get(invoiceId) ?? [])];
  if (saves.length === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.allSettled(saves),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, maxMs); }),
  ]);
  clearTimeout(timer);
}
