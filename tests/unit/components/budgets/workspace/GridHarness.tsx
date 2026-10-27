/**
 * A minimal grid over the workspace store's PUBLIC hooks, for the hook and render-count tests:
 * memo line rows reading `useGridRow`, subtotal / profit rows reading `useGridTotal`, the keyboard
 * and clipboard hooks on the table, cells carrying `data-pos`, the editor inside the active cell.
 * Each row sits in a React Profiler, so a test sees exactly which rows rendered.
 */
import { Profiler, memo, useRef, type ProfilerOnRenderCallback } from 'react';
import type { RoundingUnit } from '@/modules/accounting/services/budgets/grid/cents';
import type { Metric } from '@/modules/accounting/services/budgets/grid/subtotals';
import type { GridStore } from '@/components/accounting/budgets/workspace/gridStore';
import { useGridLayout, useGridRow, useGridTotal } from '@/components/accounting/budgets/workspace/gridStoreHooks';
import { useGridKeyboard, type GridKeyboardHandlers } from '@/components/accounting/budgets/workspace/useGridKeyboard';
import { useGridClipboard } from '@/components/accounting/budgets/workspace/useGridClipboard';

const show = (v: number | null | undefined) => (v === null || v === undefined ? '' : String(v));

const Line = memo(function Line({ store, rowKey, r, cols, keys }: { store: GridStore; rowKey: string; r: number; cols: number; keys: GridKeyboardHandlers }) {
  const row = useGridRow(store, rowKey);
  return (
    <tr data-row={rowKey}>
      {Array.from({ length: cols }, (_, c) => (
        <td key={c} role="gridcell" data-pos={`${r}:${c}`} tabIndex={row.focusCol === c ? 0 : -1}
          aria-selected={row.selected !== null && c >= row.selected.left && c <= row.selected.right}
          onMouseDown={e => keys.onCellMouseDown({ r, c }, e.shiftKey)} onMouseEnter={() => keys.onCellMouseEnter({ r, c })}
          onDoubleClick={() => keys.onCellDoubleClick({ r, c })}>
          {row.editing?.col === c
            ? <input aria-label="cell editor" value={row.editing.draft} autoFocus onChange={e => keys.onDraftChange(e.target.value)} onBlur={keys.onEditorBlur} />
            : show(c === cols - 1 ? row.fy : row.values[c])}
        </td>
      ))}
    </tr>
  );
});

const Total = memo(function Total({ store, metric }: { store: GridStore; metric: Metric }) {
  const t = useGridTotal(store, metric);
  return <tr data-total={metric}><td>{t.fy}</td></tr>;
});

export interface HarnessProps {
  store: GridStore;
  onRender?: ProfilerOnRenderCallback;
  onSave?: () => void;
  onExit?: () => void;
  unit?: RoundingUnit;
}

export function GridHarness({ store, onRender = () => {}, onSave = () => {}, onExit = () => {}, unit = 1 }: HarnessProps) {
  const layout = useGridLayout(store);
  const gridRef = useRef<HTMLTableElement>(null);
  const keys = useGridKeyboard({ store, gridRef, roundingUnit: unit, onSave, onExit });
  const clip = useGridClipboard(store);
  return (
    <table role="grid" ref={gridRef} onKeyDown={keys.onKeyDown} onCopy={clip.onCopy} onCut={clip.onCut} onPaste={clip.onPaste}>
      <tbody>
        {layout.rows.map(row => (
          <Profiler key={row.key} id={row.key} onRender={onRender}>
            {row.kind === 'line'
              ? <Line store={store} rowKey={row.key} r={row.index} cols={layout.cols} keys={keys} />
              : row.kind === 'section' ? <tr><td>{row.label}</td></tr> : <Total store={store} metric={row.metric} />}
          </Profiler>
        ))}
      </tbody>
    </table>
  );
}
