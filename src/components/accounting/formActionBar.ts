/**
 * Phone layout for the two-column create forms (receipt, supplier payment, credit note; app audit 12 Nov 2026).
 * Below lg the summary card stacks under the form, so its submit row is pinned to the bottom of the screen instead:
 * Save is never below the fold. From lg every class here is inert and the row sits in the sticky summary card as
 * before. Put FORM_PHONE_ACTION_PAD on the <form> so the pinned bar never covers the last field.
 * z-10 keeps it under the z-20 typeahead dropdowns and the z-50 dialogs and toasts.
 */
export const FORM_PHONE_ACTION_BAR = [
  'max-lg:fixed max-lg:inset-x-0 max-lg:bottom-0 max-lg:z-10',
  'max-lg:flex max-lg:flex-row-reverse max-lg:items-center max-lg:gap-2',
  'max-lg:border-t max-lg:border-[var(--ff-border-light)] max-lg:bg-[var(--ff-bg-secondary)]',
  'max-lg:px-4 max-lg:pt-3 max-lg:pb-[calc(0.75rem+env(safe-area-inset-bottom))]',
].join(' ');

/** Room under the form for the pinned bar (44px button, its padding and the iPhone home indicator). */
export const FORM_PHONE_ACTION_PAD = 'max-lg:pb-32';

/** The submit button inside the bar: drops its desktop top margin and takes the free width. */
export const FORM_PHONE_SUBMIT = 'max-lg:mt-0 max-lg:flex-1 max-lg:min-h-11';

/** A 44px tap target below lg (mobile audit M07); desktop sizes are unchanged. */
export const PHONE_TAP = 'max-lg:min-h-11';

/** An icon-only button: 44 by 44 below lg. */
export const PHONE_TAP_ICON = 'max-lg:min-h-11 max-lg:min-w-11 inline-flex items-center justify-center';
