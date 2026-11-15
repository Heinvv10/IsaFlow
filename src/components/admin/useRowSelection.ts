/**
 * Ticked rows of an admin list, by id: select-all over the rows on screen, its indeterminate state, and one-row toggles.
 */
import { useState } from 'react';

export function useRowSelection(rows: ReadonlyArray<{ id: string }>) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Header checkbox state
  const allSelected   = rows.length > 0 && rows.every(r => selectedIds.has(r.id));
  const someSelected  = rows.some(r => selectedIds.has(r.id)) && !allSelected;

  function toggleSelectAll() {
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(rows.map(r => r.id)));
    }
  }

  function toggleRow(id: string) {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  return { selectedIds, setSelectedIds, allSelected, someSelected, toggleSelectAll, toggleRow };
}
