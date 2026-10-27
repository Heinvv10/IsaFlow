/**
 * The in-cell editor (spec §4.4, §5.2 edit mode): an input laid over the active cell. It owns no
 * keys: Enter / Tab / Esc bubble to the grid element, whose keyboard hook commits or cancels, and
 * blur commits. It takes focus when it mounts with the caret at the end (type-to-overwrite puts
 * the typed character there; F2 / double-click put the current value there).
 *
 * The border is a token in both themes: the old month inputs were borderless in dark.
 */
import { useEffect, useRef } from 'react';

interface BudgetCellEditorProps {
  draft: string;
  /** "<account> <month> budget" */
  label: string;
  onDraftChange(text: string): void;
  onBlur(): void;
}

export function BudgetCellEditor({ draft, label, onDraftChange, onBlur }: BudgetCellEditorProps) {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const end = el.value.length;
    el.setSelectionRange(end, end);
  }, []);

  return (
    <input
      ref={ref}
      type="text"
      inputMode="decimal"
      autoComplete="off"
      spellCheck={false}
      aria-label={label}
      data-cell-editor=""
      value={draft}
      onChange={e => onDraftChange(e.target.value)}
      onBlur={onBlur}
      className="absolute inset-0 z-[5] w-full h-full px-2 text-right tabular-nums text-sm bg-[var(--ff-bg-primary)] text-[var(--ff-text-primary)] border-2 border-[var(--ff-cell-focus-ring)] rounded-none outline-none"
      style={{ fontFamily: 'var(--ff-fig-font, inherit)' }}
    />
  );
}
