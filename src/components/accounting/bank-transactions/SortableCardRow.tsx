/**
 * SortableCardRow — the bank card row's drag-and-drop. Each card is wrapped
 * in a slot that is both draggable and a drop target: dropping a card on
 * another takes that card's place. A drag starts only after the pointer moves
 * 6px, so a plain click still selects the card, and the click a drag can end
 * with is swallowed. Keyboard: Alt+ArrowLeft / Alt+ArrowRight on a focused
 * card moves it one place.
 */

import { useRef, type ReactNode } from 'react';
import { DndContext, PointerSensor, useDraggable, useDroppable, useSensor, useSensors } from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import { moveCard, moveCardBy } from './bankCardOrder';

export interface SortableCard {
  key: string;
  node: ReactNode;
}

interface Props {
  cards: SortableCard[];
  onReorder: (keys: string[]) => void;
}

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
      aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
      onKeyDown={(e) => {
        if (!e.altKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
        e.preventDefault();
        onStep(e.key === 'ArrowLeft' ? -1 : 1);
      }}
      onClickCapture={(e) => { if (swallowClick()) { e.preventDefault(); e.stopPropagation(); } }}
      style={t ? { transform: `translate3d(${t.x}px, ${t.y}px, 0)`, zIndex: 20, position: 'relative' } : undefined}
      className={`flex shrink-0 rounded-lg touch-none ${drag.isDragging ? 'cursor-grabbing shadow-xl' : 'cursor-grab'} ${
        drop.isOver && !drag.isDragging ? 'ring-2 ring-teal-600 ring-offset-2 ring-offset-[var(--ff-bg-secondary)]' : ''}`}
    >
      {children}
    </div>
  );
}

export function SortableCardRow({ cards, onReorder }: Props) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const keys = cards.map(c => c.key);
  const dragged = useRef(false);

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    dragged.current = true;
    // The click a drag ends with (if any) arrives in this task; later clicks are real.
    setTimeout(() => { dragged.current = false; }, 0);
    if (over && over.id !== active.id) onReorder(moveCard(keys, String(active.id), String(over.id)));
  };
  const swallowClick = () => dragged.current;

  return (
    <DndContext sensors={sensors} onDragEnd={onDragEnd} onDragCancel={() => { dragged.current = false; }}>
      {cards.map(c => (
        <Slot key={c.key} id={c.key} swallowClick={swallowClick}
          onStep={(step) => onReorder(moveCardBy(keys, c.key, step))}>
          {c.node}
        </Slot>
      ))}
    </DndContext>
  );
}
