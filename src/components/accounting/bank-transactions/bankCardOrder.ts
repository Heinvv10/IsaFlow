/**
 * bankCardOrder — a user's own order of the bank-transactions card row
 * (primary accounts by id, groups as `group:<groupId>`). Saved per user and
 * company in user_preferences; cards the saved order does not know (a new
 * account) follow it in their usual order, and keys for cards that are gone
 * are ignored.
 */

export const cardOrderPrefKey = (companyId: string) => `bank_card_order:${companyId}`;

export function applyCardOrder(keys: string[], saved: string[] | null): string[] {
  if (!saved) return keys;
  const present = new Set(keys);
  const first = [...new Set(saved)].filter(k => present.has(k));
  const placed = new Set(first);
  return [...first, ...keys.filter(k => !placed.has(k))];
}

/** Drop `from` on `to`: it takes `to`'s position. */
export function moveCard(order: string[], from: string, to: string): string[] {
  const i = order.indexOf(from);
  const j = order.indexOf(to);
  if (i < 0 || j < 0 || i === j) return order;
  const next = order.filter(k => k !== from);
  next.splice(j, 0, from);
  return next;
}

/** One step left (-1) or right (+1), clamped at the ends. */
export function moveCardBy(order: string[], key: string, step: -1 | 1): string[] {
  const i = order.indexOf(key);
  const target = order[i + step];
  return i < 0 || target === undefined ? order : moveCard(order, key, target);
}

export function parseCardOrder(raw: string | undefined): string[] | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) && v.every(x => typeof x === 'string') ? v : null;
  } catch {
    return null;
  }
}
