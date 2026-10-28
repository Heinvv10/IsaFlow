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
 */

import { useRef, useState, type ReactNode } from 'react';
import { DndContext, MouseSensor, TouchSensor, useDraggable, useDroppable, useSensor, useSensors } from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import { moveCard, moveCardBy } from './bankCardOrder';

export interface SortableCard {
  key: string;
  /** Read out when the card moves ("Main moved to position 2 of 5"). */
  label: string;
  node: ReactNode;
}

interface Props {
  cards: SortableCard[];
  onReorder: (keys: string[]) => void;
}

/** A click this soon after a drop is the drop's own click, not a choice. */
const DROP_CLICK_MS = 300;

function Slot({ id, children, onStep, swallowClick }: {
  id: string; children: ReactNode; onStep: (step: -1 | 1) => void; swallowClick: () => boolean;
}) {
  const drag = useDraggable({ id });
  const drop = useDroppable({ id });
  const t = drag.transform;
  return (
    <div
      ref={(el) => { drag.setNodeRef(el); drop.setNodeRef(el); }}
      {...drag.listeners}
      data-testid="bank-card-slot"
      data-card-key={id}
      onKeyDown={(e) => {
        if (!e.altKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
        e.preventDefault();
        onStep(e.key === 'ArrowLeft' ? -1 : 1);
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
        <Slot key={c.key} id={c.key} swallowClick={() => Date.now() - droppedAt.current < DROP_CLICK_MS}
          onStep={(step) => onStep(c.key, step)}>
          {c.node}
        </Slot>
      ))}
      <span className="sr-only" aria-live="polite" data-testid="bank-cards-announcement">{announcement}</span>
    </DndContext>
  );
}
