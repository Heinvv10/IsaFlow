/**
 * The grid's key and mouse model (spec §5.2) as a pure reducer:
 * `(state, action, ctx) → {state, effects, handled}`. The DOM hook
 * (`useGridKeyboard`) turns events into actions and executes the effects;
 * `handled` tells it whether to preventDefault.
 *
 * Copy, cut and paste return `handled: false`: the browser then fires its
 * native clipboard event, and the clipboard hook does the work there (no
 * clipboard-permission API). Their effects only carry the selection.
 */
import {
  type Dir, type GridShape, type Pos, type Rect,
  clampToEditable, edgeFocusable, isLine, lineRows, nextFocusable, normalise,
} from './selection';

export type GridMode = 'nav' | 'edit';
export type EditOrigin = 'type' | 'f2' | 'dblclick';

export interface GridState {
  focus: Pos;
  anchor: Pos;
  mode: GridMode;
  draft: string;
  editOrigin: EditOrigin | null;
}

export interface GridContext {
  shape: GridShape;
  isEditable(p: Pos): boolean;
  /** Why a cell is read-only ("Locked version", "Company roll-up", …); null when editable. */
  readReason(p: Pos): string | null;
  /** The cell's value as edit text (`1234.50`, '' when not budgeted), for F2 / double-click. */
  rawValue(p: Pos): string;
}

export type GridAction =
  | { type: 'key'; key: string; shift?: boolean; ctrl?: boolean; alt?: boolean }
  | { type: 'click'; pos: Pos; shift?: boolean }
  | { type: 'drag'; pos: Pos }
  | { type: 'dblclick'; pos: Pos }
  | { type: 'draft'; draft: string }
  | { type: 'blur' };

export type GridEffect =
  /** `isTotal`: the FY total column; the store spreads it evenly. */
  | { type: 'commit'; pos: Pos; draft: string; isTotal: boolean }
  | { type: 'clear'; cells: Pos[] }
  | { type: 'copy'; rect: Rect; cut: boolean }
  | { type: 'paste'; rect: Rect }
  | { type: 'fillDown'; rect: Rect }
  | { type: 'fillRight'; rect: Rect }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'save' }
  | { type: 'announce'; message: string }
  /** Tab off the last column: focus leaves the grid (to the save bar). */
  | { type: 'exit' };

export interface GridResult {
  state: GridState;
  effects: GridEffect[];
  handled: boolean;
}

const PAGE_ROWS = 20;
const TYPE_TO_EDIT = /^[0-9.\-(Rr]$/;
const ARROWS: Record<string, Dir> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

export function initialGridState(shape: GridShape): GridState {
  const first = lineRows(shape)[0] ?? 0;
  return { focus: { r: first, c: 0 }, anchor: { r: first, c: 0 }, mode: 'nav', draft: '', editOrigin: null };
}

const done = (state: GridState, effects: GridEffect[] = [], handled = true): GridResult => ({ state, effects, handled });
const moveTo = (s: GridState, p: Pos): GridState => ({ ...s, focus: p, anchor: p, mode: 'nav', draft: '', editOrigin: null });
const lastMonth = (shape: GridShape): number => Math.max(0, shape.cols - 2);
const rectOf = (s: GridState): Rect => normalise(s.anchor, s.focus);

function commitOf(s: GridState, ctx: GridContext): GridEffect {
  return { type: 'commit', pos: s.focus, draft: s.draft, isTotal: s.focus.c === ctx.shape.cols - 1 };
}

function startEdit(s: GridState, ctx: GridContext, draft: string, origin: EditOrigin): GridResult {
  if (!ctx.isEditable(s.focus)) return done(s, [{ type: 'announce', message: ctx.readReason(s.focus) ?? 'Read-only' }]);
  return done({ ...s, anchor: s.focus, mode: 'edit', draft, editOrigin: origin });
}

/** Tab / Shift+Tab: stop at the row edge; Tab off the last column leaves the grid. */
function tab(s: GridState, ctx: GridContext, back: boolean, pre: GridEffect[]): GridResult {
  const base = { ...s, mode: 'nav' as const, draft: '', editOrigin: null };
  if (!back && s.focus.c === ctx.shape.cols - 1) return done(base, [...pre, { type: 'exit' }]);
  return done(moveTo(base, nextFocusable(s.focus, back ? 'left' : 'right', ctx.shape)), pre);
}

function ctrlKey(s: GridState, k: string, shift: boolean, ctx: GridContext): GridResult | null {
  const { shape } = ctx;
  const rows = lineRows(shape);
  switch (k.toLowerCase()) {
    case 'c': return done(s, [{ type: 'copy', rect: rectOf(s), cut: false }], false);
    case 'x': return done(s, [{ type: 'copy', rect: rectOf(s), cut: true }], false);
    case 'v': return done(s, [{ type: 'paste', rect: rectOf(s) }], false);
    case 'd': return done(s, [{ type: 'fillDown', rect: rectOf(s) }]);
    case 'r': return done(s, [{ type: 'fillRight', rect: rectOf(s) }]);
    case 'z': return done(s, [{ type: shift ? 'redo' : 'undo' }]);
    case 'y': return done(s, [{ type: 'redo' }]);
    case 's': return done(s, [{ type: 'save' }]);
    case 'a':
      if (rows.length === 0) return done(s);
      return done({ ...s, anchor: { r: rows[0], c: 0 }, focus: { r: rows[rows.length - 1], c: lastMonth(shape) } });
    case 'home': return rows.length ? done(moveTo(s, { r: rows[0], c: 0 })) : done(s);
    case 'end': return rows.length ? done(moveTo(s, { r: rows[rows.length - 1], c: lastMonth(shape) })) : done(s);
    default: {
      const dir = ARROWS[k];
      return dir ? done(moveTo(s, edgeFocusable(s.focus, dir, shape))) : null;
    }
  }
}

function navKey(s: GridState, a: Extract<GridAction, { type: 'key' }>, ctx: GridContext): GridResult {
  const { shape } = ctx;
  const shift = a.shift === true;
  if (a.ctrl) return ctrlKey(s, a.key, shift, ctx) ?? done(s, [], false);
  const dir = ARROWS[a.key];
  if (dir) {
    const to = nextFocusable(s.focus, dir, shape);
    return done(shift ? { ...s, focus: to } : moveTo(s, to));
  }
  switch (a.key) {
    case 'Home': return done(moveTo(s, { r: s.focus.r, c: 0 }));
    case 'End': return done(moveTo(s, { r: s.focus.r, c: lastMonth(shape) }));
    case 'PageDown': return done(moveTo(s, nextFocusable(s.focus, 'down', shape, PAGE_ROWS)));
    case 'PageUp': return done(moveTo(s, nextFocusable(s.focus, 'up', shape, PAGE_ROWS)));
    case 'Tab': return tab(s, ctx, shift, []);
    case 'Enter': return done(moveTo(s, nextFocusable(s.focus, shift ? 'up' : 'down', shape)));
    case 'F2': return startEdit(s, ctx, ctx.rawValue(s.focus), 'f2');
    case 'Escape': return done({ ...s, anchor: s.focus });
    case 'Delete':
    case 'Backspace': {
      const cells = clampToEditable(rectOf(s), shape, ctx.isEditable);
      if (cells.length === 0) return done(s, [{ type: 'announce', message: ctx.readReason(s.focus) ?? 'Read-only' }]);
      return done(s, [{ type: 'clear', cells }]);
    }
    default:
      if (!a.alt && TYPE_TO_EDIT.test(a.key)) return startEdit(s, ctx, a.key, 'type');
      return done(s, [], false);
  }
}

function editKey(s: GridState, a: Extract<GridAction, { type: 'key' }>, ctx: GridContext): GridResult {
  const shift = a.shift === true;
  if (a.ctrl && a.key.toLowerCase() === 's') {
    return done({ ...s, mode: 'nav', draft: '', editOrigin: null }, [commitOf(s, ctx), { type: 'save' }]);
  }
  switch (a.key) {
    case 'Enter':
      return done(moveTo(s, nextFocusable(s.focus, shift ? 'up' : 'down', ctx.shape)), [commitOf(s, ctx)]);
    case 'Tab': return tab(s, ctx, shift, [commitOf(s, ctx)]);
    case 'Escape': return done(moveTo(s, s.focus));
    default: return done(s, [], false);
  }
}

export function gridReducer(s: GridState, a: GridAction, ctx: GridContext): GridResult {
  switch (a.type) {
    case 'key': return s.mode === 'edit' ? editKey(s, a, ctx) : navKey(s, a, ctx);
    case 'draft': return s.mode === 'edit' ? done({ ...s, draft: a.draft }) : done(s, [], false);
    case 'blur': return s.mode === 'edit' ? done(moveTo(s, s.focus), [commitOf(s, ctx)]) : done(s, [], false);
    case 'click': {
      if (!isLine(ctx.shape, a.pos.r)) return done(s, [], false);
      if (s.mode === 'edit' && a.pos.r === s.focus.r && a.pos.c === s.focus.c) return done(s, [], false);
      const pre = s.mode === 'edit' ? [commitOf(s, ctx)] : [];
      const base = { ...s, mode: 'nav' as const, draft: '', editOrigin: null };
      return done(a.shift ? { ...base, focus: a.pos } : moveTo(base, a.pos), pre);
    }
    case 'drag':
      if (s.mode === 'edit' || !isLine(ctx.shape, a.pos.r)) return done(s, [], false);
      return done({ ...s, focus: a.pos });
    case 'dblclick': {
      if (!isLine(ctx.shape, a.pos.r)) return done(s, [], false);
      return startEdit(moveTo(s, a.pos), ctx, ctx.rawValue(a.pos), 'dblclick');
    }
  }
}
