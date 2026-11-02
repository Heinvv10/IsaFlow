/**
 * What a later migration may not do to 888's change history: the text rule entityChangeCensus.test.ts judges every
 * migration by, and the views of its text the rule is judged on (as written, folded, with escapes spelled out).
 */
const TRACKED_TABLE_SQL = String.raw`(?:(?:only|if\s+exists)\s+)*(?:"?public"?\s*\.\s*)?"?(?:suppliers|customers|gl_accounts|payroll_employees|company_users|company_invitations|company_user_permissions|companies|approval_rules|approval_enforcement|payroll_bank_details)"?(?![\w"])`;

/**
 * Escaped text spelled back out (breaker r3–r4): E'…' strings (\xHH, \uXXXX, \UXXXXXXXX, octal, '') and U&"…" /
 * U&'…' (\XXXX, \+XXXXXX), so a name hidden behind escapes meets the same rules as one written plainly — and a
 * harmless escape (E'\x1f') meets them as the harmless character it is.
 */
export function decodeEscapes(sql: string): string {
  const cp = (hex: string) => String.fromCodePoint(parseInt(hex, 16));
  return sql
    .replace(/\bE'((?:[^'\\]|\\.|'')*)'/gi, (_m, body: string) => `'${body
      .replace(/\\x([0-9a-fA-F]{1,2})/g, (_x, h: string) => cp(h))
      // \U before \u, letters case-sensitive (breaker r5 #1: an /i \u rule ate \U's first four digits).
      .replace(/\\U([0-9a-fA-F]{8})/g, (_x, h: string) => cp(h))
      .replace(/\\u([0-9a-fA-F]{4})/g, (_x, h: string) => cp(h))
      .replace(/\\([0-7]{1,3})/g, (_x, o: string) => String.fromCharCode(parseInt(o, 8)))
      // \b \f \n \r \t are whitespace to Postgres (blind r6 N-5: \n read as the letter n joined DISABLE\nTRIGGER).
      .replace(/\\([bfnrt])/g, ' ')
      .replace(/\\(.)/g, '$1')}'`)
    // U&'…' / U&"…", with UESCAPE 'c' naming another escape character (security review of d5665093).
    .replace(/\bU&(["'])((?:(?!\1)[\s\S]|\1\1)*)\1(?:\s*uescape\s*'([^'])')?/gi,
      (_m, q: string, body: string, esc?: string) => {
        const e = (esc ?? '\\').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return `${q}${body
          .replace(new RegExp(`${e}\\+([0-9a-f]{6})`, 'gi'), (_x, h: string) => cp(h))
          .replace(new RegExp(`${e}([0-9a-f]{4})`, 'gi'), (_x, h: string) => cp(h))}${q}`;
      });
}

function violates(sql: string): boolean {
  return /\bentity_change/i.test(sql)
    // With standard_conforming_strings off, a plain '…' string decodes backslash escapes too, which decodeEscapes does
    // not (security review of d5665093): a migration may not touch the setting.
    || /\bstandard_conforming_strings\b/i.test(sql)
    // Any trigger switch but ENABLE ALWAYS, on any table, literal or inside a format() string (blind review r2 L-3):
    // DISABLE stops a capture; a plain or REPLICA ENABLE takes it out of ALWAYS, so it no longer fires under replica.
    || /\b(?:disable|enable(?!\s+always\b))(?:\s+replica)?\s+trigger\b/i.test(sql)
    // A schema-wide grant whose schema list holds public, quoted or not (breaker r2 #1, r4: public as the grantee is
    // not one): hands app_user INSERT, the capture or the seq sequence back.
    || /\bgrant\b[^;]*\bon\s+all\s+(?:tables|sequences|functions|routines|procedures)\s+in\s+schema\s+(?:"?\w+"?\s*,\s*)*"?public"?(?![\w"])/i.test(sql)
    // Swapping a tracked table out from under its capture (breaker r2 #1): rename, move or drop it.
    || new RegExp(String.raw`\balter\s+table\s+${TRACKED_TABLE_SQL}\s*\*?\s+(?:rename\s+to|set\s+schema)\b`, 'i').test(sql)
    || new RegExp(String.raw`\bdrop\s+table\b[^;]*?\b${TRACKED_TABLE_SQL}`, 'i').test(sql)
    // TRUNCATE fires no row trigger: emptying a tracked table records nothing (breaker r3 #1) — anywhere, a DO block
    // or a function body included (blind r4 N-3) — and TRUNCATE … CASCADE empties every table referencing the named
    // one, tracked tables included (breaker r4). A privilege list (REVOKE …, TRUNCATE ON t … CASCADE) is not one.
    || new RegExp(String.raw`\btruncate\s+(?!on\b)(?:table\s+)?(?:(?:only\s+)?[\w"]+(?:\s*\.\s*[\w"]+)?\s*\*?\s*,\s*)*${TRACKED_TABLE_SQL}`, 'i').test(sql)
    || /\btruncate\s+(?!on\b)(?:table\s+)?(?:only\s+)?[\w"]+(?:\s*\.\s*[\w"]+)?[^;]*\bcascade\b/i.test(sql);
}

/**
 * Every backslash and U&-style escape spelled out wherever it stands, not only inside strings the patterns above
 * recognise (blind review r5 N-4: a plain string ending in " E" makes `E'` pair the wrong quotes). Judging is
 * additive, so decoding too much can only refuse more, never pass a statement the other views refuse.
 */
export function decodeEverywhere(sql: string): string {
  const cp = (hex: string) => String.fromCodePoint(parseInt(hex, 16));
  return sql
    .replace(/\\x([0-9a-fA-F]{1,2})/g, (_x, h: string) => cp(h))
    .replace(/\\U([0-9a-fA-F]{8})/g, (_x, h: string) => cp(h))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_x, h: string) => cp(h))
    .replace(/\\\+([0-9a-f]{6})/gi, (_x, h: string) => cp(h))
    .replace(/\\([0-9a-f]{4})/gi, (_x, h: string) => cp(h))
    .replace(/\\([0-7]{1,3})/g, (_x, o: string) => String.fromCharCode(parseInt(o, 8)))
    .replace(/\\[bfnrt]/g, ' ');
}

/**
 * Adjacent string constants separated only by a newline (and whitespace or a `--` comment) are ONE constant to
 * Postgres's lexer: 'DROP TRIGGER entity'⏎'_change_capture …' (breaker r5 #2). Folded before the other views.
 */
export const foldContinuations = (sql: string): string => sql.replace(/'(?:[ \t\f\r]*(?:--[^\n]*)?\n[ \t\f\r]*)+'/g, '');

/** What another migration may not do to 888 — judged as written, folded, with string escapes and with every escape spelled out. */
export function laterMigrationViolates(sql: string): boolean {
  const folded = foldContinuations(sql);
  return [sql, folded, decodeEscapes(folded), decodeEverywhere(folded)].some(violates);
}
