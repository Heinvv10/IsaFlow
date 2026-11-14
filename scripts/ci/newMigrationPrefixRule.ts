/**
 * A migration ADDED on a branch must not share its numeric prefix with any other file in scripts/migrations/sql/
 * (244_ and 244b_ both sort under 244 and run in no fixed order). The 22 historic duplicates are applied and cannot be
 * renamed, so `validate-migrations.mjs` exits 1 on master; this checks only what a branch adds. Closes #1380.
 */

/** Leading digit run of a migration filename, or null when it has none. */
export function migrationPrefix(file: string): string | null {
  const m = /^(\d+)/.exec(file);
  return m ? (m[1] as string) : null;
}

export function findNewPrefixCollisions(added: string[], all: string[]): string[] {
  const byPrefix = new Map<string, string[]>();
  for (const f of all) {
    const p = migrationPrefix(f);
    if (p === null) continue;
    byPrefix.set(p, [...(byPrefix.get(p) ?? []), f]);
  }
  const errors: string[] = [];
  for (const f of added) {
    const p = migrationPrefix(f);
    if (p === null) {
      errors.push(`${f}: a migration name must start with its number (NNN_description.sql)`);
      continue;
    }
    const others = (byPrefix.get(p) ?? []).filter((o) => o !== f);
    if (others.length) errors.push(`${f}: prefix ${p} is also used by ${others.join(', ')}; take the next free number`);
  }
  return errors;
}
