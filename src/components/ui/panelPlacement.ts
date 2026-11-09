/**
 * Where a portalled or fixed dropdown panel goes relative to its trigger (viewport coordinates).
 * The side is chosen once, when the panel opens (`chooseSide`): down unless there is less room below than the
 * panel wants and more above. It is then kept, so typing in a search box cannot flip the panel under the pointer.
 * `placePanel` places the panel on that side; its max height is the room on that side (the list scrolls inside
 * it), so it never runs off the viewport, even where both sides are short.
 */

export type PanelSide = 'down' | 'up';

export interface PanelPlacement {
  /** Viewport y of the panel's top edge when it opens downward. */
  top?: number;
  /** Distance from the viewport's bottom edge to the panel's bottom edge when it opens upward. */
  bottom?: number;
  maxHeight: number;
}

type Box = { top: number; bottom: number };

const GAP = 4;
const MARGIN = 8;

const roomBelow = (t: Box, vh: number): number => vh - t.bottom - GAP - MARGIN;
const roomAbove = (t: Box): number => t.top - GAP - MARGIN;

/** `wanted` is the panel's natural height (search box + list + footer) when it opens. */
export function chooseSide(trigger: Box, viewportHeight: number, wanted: number): PanelSide {
  const below = roomBelow(trigger, viewportHeight);
  return below >= wanted || below >= roomAbove(trigger) ? 'down' : 'up';
}

export function placePanel(trigger: Box, viewportHeight: number, side: PanelSide): PanelPlacement {
  if (side === 'down') return { top: trigger.bottom + GAP, maxHeight: Math.max(roomBelow(trigger, viewportHeight), 0) };
  return { bottom: viewportHeight - trigger.top + GAP, maxHeight: Math.max(roomAbove(trigger), 0) };
}
