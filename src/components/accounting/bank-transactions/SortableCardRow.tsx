/**
 * SortableCardRow — the bank card row's drag-and-drop. Each card is wrapped
 * in a slot that is both draggable and a drop target: dropping a card on
 * another takes that card's place.
 *  - Mouse: a drag starts after 6px, so a plain click still selects the card;
 *    the click a drag can end with is swallowed.
 *  - Touch: a drag starts after a 250ms press, so a swipe still scrolls the row.
 *  - Keyboard: Alt+ArrowLeft / Alt+ArrowRight on a focused card moves it one
 *    place; focus stays on it (React moves the node; checked in Chromium) and the
 *    new position is announced.
 *  - ONE tab stop for the whole row (roving tabindex, WP5): only the active card's buttons are tabbable; plain
 *    ArrowLeft / ArrowRight / Home / End move focus between cards. The active card starts as the selected one.
 */

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { DndContext, MouseSensor, TouchSensor, useDraggable, useDroppable, useSensor, useSensors } from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import { moveCard, moveCardBy } from './bankCardOrder';

export interface SortableCard {
  key: string;
  /** Read out when the card moves ("Main moved to position 2 of 5"). */
  label: string;
  node: ReactNode;
  /** The selected account's card: the row's tab stop until focus moves. */
  current?: boolean;
}

interface Props {
  cards: SortableCard[];
  onReorder: (keys: string[]) => void;
}

/** A click this soon after a drop is the drop's own click, not a choice. */
const DROP_CLICK_MS = 300;

interface SlotProps {
  id: string; children: ReactNode; active: boolean; swallowClick: () => boolean;
  onStep: (step: -1 | 1) => void; onNav: (to: 'prev' | 'next' | 'first' | 'last') => void; onActive: () => void;
  reg: (node: HTMLElement | null) => void;
}

const NAV_KEYS: Record<string, 'prev' | 'next' | 'first' | 'last'> = {
  ArrowLeft: 'prev', ArrowRight: 'next', Home: 'first', End: 'last',
};

function Slot({ id, children, active, onStep, onNav, onActive, reg, swallowClick }: SlotProps) {
  const drag = useDraggable({ id });
  const drop = useDroppable({ id });
  const el = useRef<HTMLDivElement | null>(null);
  // Roving tabindex: only the active card's buttons can take a Tab; re-applied on every render, since the card's
  // own content (a worklist toggle, a resume link) can appear later.
  useLayoutEffect(() => {
    el.current?.querySelectorAll('button').forEach((b) => { b.tabIndex = active ? 0 : -1; });
  });
  const t = drag.transform;
  return (
    <div
      ref={(node) => { el.current = node; reg(node); drag.setNodeRef(node); drop.setNodeRef(node); }}
      {...drag.listeners}
      data-testid="bank-card-slot"
      data-card-key={id}
      onFocusCapture={onActive}
      onKeyDown={(e) => {
        if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
          e.preventDefault();
          onStep(e.key === 'ArrowLeft' ? -1 : 1);
          return;
        }
        const nav = NAV_KEYS[e.key];
        if (!nav || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
        e.preventDefault();
        onNav(nav);
      }}
      onClickCapture={(e) => { if (swallowClick()) { e.preventDefault(); e.stopPropagation(); } }}
      style={t ? { transform: `translate3d(${t.x}px, ${t.y}px, 0)`, zIndex: 20, position: 'relative' } : undefined}
      className={`flex shrink-0 rounded-lg ${drag.isDragging ? 'cursor-grabbing shadow-xl' : 'cursor-grab'} ${
        drop.isOver && !drag.isDragging ? 'ring-2 ring-teal-600 ring-offset-2 ring-offset-[var(--ff-bg-secondary)]' : ''}`}
    >
      {children}
    </div>
  );
}

export function SortableCardRow({ cards, onReorder }: Props) {
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 6 } }),
  );
  const keys = cards.map(c => c.key);
  const droppedAt = useRef(0);
  const [announcement, setAnnouncement] = useState('');
  const slots = useRef(new Map<string, HTMLElement>());
  const [activeKey, setActiveKey] = useState<string | null>(null);
  // The selection moving (a pick from the switcher, a click) makes the selected card the tab stop again.
  const currentKey = cards.find(c => c.current)?.key;
  useEffect(() => { setActiveKey(null); }, [currentKey]);
  const active = activeKey !== null && keys.includes(activeKey) ? activeKey : (cards.find(c => c.current) ?? cards[0])?.key;
  const onNav = (from: string, to: 'prev' | 'next' | 'first' | 'last') => {
    const i = keys.indexOf(from);
    const target = to === 'first' ? 0 : to === 'last' ? keys.length - 1 : i + (to === 'next' ? 1 : -1);
    const key = keys[Math.min(keys.length - 1, Math.max(0, target))];
    if (key === undefined || key === from) return;
    setActiveKey(key);
    slots.current.get(key)?.querySelector('button')?.focus();
  };

  const announce = (key: string, next: string[]) => {
    const label = cards.find(c => c.key === key)?.label ?? 'Card';
    setAnnouncement(`${label} moved to position ${next.indexOf(key) + 1} of ${next.length}`);
  };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    droppedAt.current = Date.now();
    if (!over || over.id === active.id) return;
    const next = moveCard(keys, String(active.id), String(over.id));
    onReorder(next);
    announce(String(active.id), next);
  };
  const onStep = (key: string, step: -1 | 1) => {
    const next = moveCardBy(keys, key, step);
    if (next === keys) return;
    onReorder(next);
    announce(key, next);
  };

  return (
    <DndContext sensors={sensors} onDragEnd={onDragEnd}>
      {cards.map(c => (
        <Slot key={c.key} id={c.key} active={c.key === active} swallowClick={() => Date.now() - droppedAt.current < DROP_CLICK_MS}
          onStep={(step) => onStep(c.key, step)} onNav={(to) => onNav(c.key, to)} onActive={() => setActiveKey(c.key)}
          reg={(node) => { if (node) slots.current.set(c.key, node); else slots.current.delete(c.key); }}>
          {c.node}
        </Slot>
      ))}
      <span className="sr-only" aria-live="polite" data-testid="bank-cards-announcement">{announcement}</span>
    </DndContext>
  );
}
