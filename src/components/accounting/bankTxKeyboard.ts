/**
 * Pure key→action resolver for the bank-transactions keyboard row-stream.
 * No React/DOM imports — the hook supplies the context and performs the effects.
 *
 * While a cell input/select/textarea is focused (isEditingCell), only Escape is
 * ours (pop focus back to the row); every other key is left to native handling
 * so typing in a field never triggers a hotkey.
 */
export type BankTxKeyAction =
  | 'next' | 'prev' | 'accept' | 'edit' | 'exclude' | 'split' | 'blur-to-row';

export interface BankTxKeyContext {
  /** Focus is inside a cell input/select/textarea (i.e. the user is typing). */
  isEditingCell: boolean;
  /** The focused row has a selected allocation (suggested or user-picked) ready to post. */
  canAccept: boolean;
}

export function resolveBankTxKey(key: string, ctx: BankTxKeyContext): BankTxKeyAction | null {
  if (ctx.isEditingCell) {
    return key === 'Escape' ? 'blur-to-row' : null;
  }
  switch (key) {
    case 'ArrowDown': return 'next';
    case 'ArrowUp':   return 'prev';
    case 'Enter':     return ctx.canAccept ? 'accept' : 'edit';
    case 'e': case 'E': return 'edit';
    case 'x': case 'X': return 'exclude';
    case 's': case 'S': return 'split';
    default: return null;
  }
}
