/**
 * The invoice editor's autosave line. The edit page's is the kit's AutosaveStatus as it is; the new page's saved state
 * says where the draft is ("Saved on this device · 2 s ago"), since nothing there has reached the server yet.
 */
import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import { AutosaveStatus, formatSavedAgo, type AutosaveState } from '@/components/ui/AutosaveStatus';

interface Props {
  where: 'device' | 'server';
  state: AutosaveState | null;
  savedAt: number | null;
  error: string | null;
}

function useSecondTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export function InvoiceAutosaveStatus({ where, state, savedAt, error }: Props) {
  const onDevice = where === 'device' && state === 'saved' && savedAt !== null;
  const now = useSecondTick(onDevice);
  if (state === null) return null;
  if (!onDevice) return <AutosaveStatus state={state} savedAt={savedAt} {...(error ? { errorMessage: error } : {})} className="mt-3" />;
  return (
    <p role="status" className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-gray-600 dark:text-gray-400">
      <Check size={14} aria-hidden="true" />
      <span>{`Saved on this device · ${formatSavedAgo(now - savedAt)}`}</span>
    </p>
  );
}
