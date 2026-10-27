/**
 * The in-cell editor (spec §4.4, §5.2 edit mode): an input laid over the active cell. It owns no
 * keys: Enter / Tab / Esc bubble to the grid element, whose keyboard hook commits or cancels, and
 * blur commits. It takes focus when it mounts with the caret at the end (type-to-overwrite puts
 * the typed character there; F2 / double-click put the current value there).
 *
 * A commit the kit parser refuses keeps this editor open (the keyboard hook re-opens edit mode on
 * the same cell); once Enter / Tab was pressed on text that does not parse, the reason shows under
 * the input and the input is `aria-invalid` (QA-4). Nothing shows while the user is still typing.
 * A double-click inside the input selects text and never reaches the cell (QA-5).
 *
 * The border is a token in both themes: the old month inputs were borderless in dark.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { parseCell } from '@/modules/accounting/services/budgets/grid/pasteParse';

interface BudgetCellEditorProps {
  draft: string;
  /** "<account> <month> budget" */
  label: string;
  onDraftChange(text: string): void;
  onBlur(): void;
  /** Which way the error box opens: 'left' = from the cell's left edge rightwards (first months, so the
   *  sticky account column never covers it), 'right' = from the right edge leftwards (late months). */
  align: 'left' | 'right';
}

export function BudgetCellEditor({ draft, label, onDraftChange, onBlur, align }: BudgetCellEditorProps) {
  const ref = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const [attempted, setAttempted] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const end = el.value.length;
    el.setSelectionRange(end, end);
  }, []);

  const parsed = attempted ? parseCell(draft) : null;
  const error = parsed?.kind === 'error' ? parsed.reason : null;

  return (
    <>
      <input
        ref={ref}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        aria-label={label}
        aria-invalid={error !== null}
        aria-describedby={error !== null ? errorId : undefined}
        data-cell-editor=""
        value={draft}
        onChange={e => onDraftChange(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === 'Tab') setAttempted(true); }}
        onDoubleClick={e => e.stopPropagation()}
        onMouseDown={e => e.stopPropagation()}
        onBlur={onBlur}
        className="absolute inset-0 z-[5] w-full h-full px-2 text-right tabular-nums text-sm border-2 border-solid rounded-none outline-none"
        style={{
          fontFamily: 'var(--ff-fig-font, inherit)',
          // Inline, not Tailwind classes: globals.css's `.dark :is(input, …)` rules (fill, border and a
          // teal-500 focus border) out-rank a single utility class and would replace these tokens.
          borderColor: error !== null ? 'var(--ff-unfav)' : 'var(--ff-cell-focus-ring)',
          backgroundColor: 'var(--ff-bg-primary)',
          color: 'var(--ff-text-primary)',
          boxShadow: 'none',
        }}
      />
      {error !== null && (
        <span id={errorId} role="alert"
          className={`absolute ${align === 'left' ? 'left-0' : 'right-0'} top-full z-[15] mt-0.5 w-56 whitespace-normal rounded border border-[var(--ff-unfav)] bg-[var(--ff-bg-secondary)] px-2 py-1 text-left text-xs font-normal text-[var(--ff-text-primary)] shadow`}>
          {error}
        </span>
      )}
    </>
  );
}
