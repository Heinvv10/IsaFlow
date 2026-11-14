/** A mention's bank link that could not be opened (the line is gone): said above the list, dismissible; the list still shows. */
export function DeepLinkNotice({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  if (message === '') return null;
  return (
    <div role="alert" className="mb-2 flex items-center justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
      <span>{message}</span>
      <button type="button" onClick={onDismiss} className="shrink-0 font-medium underline ff-focus-ring rounded">Dismiss</button>
    </div>
  );
}
