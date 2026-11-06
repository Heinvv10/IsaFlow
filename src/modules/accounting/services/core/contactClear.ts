/**
 * Which columns an update CLEARS to NULL. The write services' update is COALESCE-based (an omitted field keeps its
 * value, so an MCP call that forgot a field cannot wipe it); an edit screen has to be able to blank one, so the
 * caller names those fields in `clear`. Only the fields a service lists as clearable may be named, and a field
 * cannot be both given a value and cleared.
 */
import { ContactValidationError } from './contactValidationError';

export function clearFlags<K extends string>(
  clear: readonly string[] | undefined,
  allowed: readonly K[],
  input: object,
): Record<K, boolean> {
  const wanted = new Set(clear ?? []);
  const given = input as Record<string, unknown>;
  for (const key of wanted) {
    if (!(allowed as readonly string[]).includes(key)) throw new ContactValidationError(`${key} cannot be cleared`);
    const v = given[key];
    if (v !== undefined && v !== null && v !== '') throw new ContactValidationError(`${key} cannot be both set and cleared`);
  }
  return Object.fromEntries(allowed.map((k) => [k, wanted.has(k)])) as Record<K, boolean>;
}
