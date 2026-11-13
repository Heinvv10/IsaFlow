/**
 * LIKE/ILIKE patterns built from a caller's text. Postgres's default escape character is backslash, so escaping the
 * three metacharacters with it turns the text into a literal; pair every use with an explicit `ESCAPE '\'` in the SQL
 * so the pattern does not depend on the default.
 */

/** The text with `\`, `%` and `_` escaped, so it matches only itself. `undefined` passes through. */
export function escapeLikeLiteral(term: string | undefined): string | undefined {
  if (term === undefined) return undefined;
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** `%term%` with the term as a literal, or null for an absent or empty term (a null disables the clause). */
export function containsLikePattern(term: string | undefined): string | null {
  return term === undefined || term === '' ? null : `%${escapeLikeLiteral(term)}%`;
}
