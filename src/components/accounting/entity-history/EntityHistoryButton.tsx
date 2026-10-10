/**
 * A History icon button that opens one record's change history in a drawer —
 * for rows with no detail page (GL accounts, bank accounts). The timeline
 * loads only when opened.
 */
import { useState } from 'react';
import { History } from 'lucide-react';
import { Drawer } from '@/components/ui/Drawer';
import type { EntityType } from '@/modules/accounting/services/core/entityChanges/entityChangeTypes';
import { EntityHistoryTimeline } from './EntityHistoryTimeline';

interface Props {
  entityType: EntityType;
  entityId: string;
  /** What the drawer is about, e.g. "1000 Bank". */
  label: string;
}

export function EntityHistoryButton({ entityType, entityId, label }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} title="History" aria-label={`History of ${label}`}
        className="p-1.5 rounded text-[var(--ff-text-tertiary)] hover:text-blue-400 hover:bg-blue-500/10 transition-colors">
        <History className="h-4 w-4" />
      </button>
      <Drawer open={open} onClose={() => setOpen(false)} title={`History — ${label}`} width="lg">
        {open && <EntityHistoryTimeline entityType={entityType} entityId={entityId} />}
      </Drawer>
    </>
  );
}
