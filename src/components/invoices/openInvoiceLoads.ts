/**
 * Which load the invoice page may show (PR S). The page opens one invoice at a time, in place (Back / Forward,
 * Next): a load starts only for the invoice open, and its answer is shown only if that invoice is still open AND no
 * newer load started since. Pure; one per page (useState).
 */
export interface OpenInvoiceLoads {
  /** The URL now opens `id`. */
  open: (id: string) => void;
  isOpen: (id: string) => boolean;
  /** A token for a load of `id`, or null: `id` is not the invoice open, so the load does not start. */
  begin: (id: string) => number | null;
  /** The load `token` may show its answer. */
  isCurrent: (token: number) => boolean;
}

export function openInvoiceLoads(): OpenInvoiceLoads {
  let opened = '';
  let latest = 0;
  const forToken = new Map<number, string>();
  return {
    open: (id) => { opened = id; },
    isOpen: (id) => id === opened,
    begin: (id) => {
      if (id !== opened) return null;
      latest += 1;
      forToken.clear();
      forToken.set(latest, id);
      return latest;
    },
    isCurrent: (token) => token === latest && forToken.get(token) === opened,
  };
}
