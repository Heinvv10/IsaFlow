/**
 * S-07b (migration 916): a guard that judges `current_user <> 'app_user'` lets
 * every other role through, including the service pool's isaflow_service.
 * 916 patched the two member guards and refuses that shape at the time it
 * applies; this pins it for every migration written after 916, which 916's
 * own check never sees.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const DIR = join(process.cwd(), 'scripts', 'migrations', 'sql');
// The two spellings 916 refuses, in either order (any of the four role functions, <> / != / IS DISTINCT FROM).
const OLD_SHAPE = [
  /(current_user|current_role|session_user|user)(\s*::\s*\w+)?\s*(<>|!=|is\s+distinct\s+from)\s*'app_user'(\s*::\s*\w+)?\s*(then|\))/i,
  /'app_user'(\s*::\s*\w+)?\s*(<>|!=|is\s+distinct\s+from)\s*(current_user|current_role|session_user|user)(\s*::\s*\w+)?\s*(then|\))/i,
];

const exempts = (sql: string): boolean => OLD_SHAPE.some((re) => re.test(sql));

describe('no migration after 916 exempts every role but app_user', () => {
  it('holds for every file', () => {
    const later = readdirSync(DIR).filter((f) => f.endsWith('.sql') && f.slice(0, 3) >= '917');
    expect(later.length).toBeGreaterThan(0);
    expect(later.filter((f) => exempts(readFileSync(join(DIR, f), 'utf8')))).toEqual([]);
  });

  it.each([
    [`IF current_user <> 'app_user' THEN RETURN NEW; END IF;`, true],
    [`IF 'app_user' != current_role THEN`, true],
    [`IF (session_user::text IS DISTINCT FROM 'app_user') THEN`, true],
    [`IF current_user <> 'app_user'\n     AND NOT (pg_catalog.pg_has_role(current_user, 'app_service', 'USAGE')`, false],
    [`IF current_user = 'app_user' THEN`, false],
  ])('judges %j', (sql, expected) => {
    expect(exempts(sql)).toBe(expected);
  });
});
