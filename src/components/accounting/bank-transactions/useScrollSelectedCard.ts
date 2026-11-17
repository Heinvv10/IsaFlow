/**
 * useScrollSelectedCard - the selected account's card is scrolled into view when the selection changes (WP4a): with many
 * accounts the card row scrolls sideways, and a deep link, Back or the default pick can select a card that is off screen.
 * Read-only on the cards: it finds the slot by its `data-card-key` (a primary account's id, or `group:<id>` for a sub-account
 * of a group) and only asks the browser to scroll; it changes no card state and never steals focus.
 */

import { useEffect } from 'react';

export function useScrollSelectedCard(selectedBank: string, groupId?: string | null, enabled = true, firstOrderLoad = false) {
  useEffect(() => {
    if (!selectedBank || !enabled || typeof document === 'undefined') return;
    const wanted = new Set([selectedBank, groupId ? `group:${groupId}` : '']);
    const slot = Array.from(document.querySelectorAll<HTMLElement>('[data-card-key]')).find(el => wanted.has(el.getAttribute('data-card-key') ?? ''));
    slot?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [selectedBank, groupId, enabled, firstOrderLoad]); // the selection changing, and the order's first load (the cards move once); NOT every reorder or pin toggle
}
