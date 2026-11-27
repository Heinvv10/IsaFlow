/**
 * Round 36 (B36-1, R36-1, R36-3): every read of an unknown thrown value in the migration's two trees goes through sageTold.ts (told, codeOf,
 * asError, safeThrown). A census, line by line, of every .ts file under src/modules/accounting/services/sage-migration and
 * scripts/sage-migration (read from disk, so a new untracked file is counted too): a bare String(<thrown>), a .message / .code read of a
 * thrown value, or a cast-to-errno .code read is refused, unless the allowlist names it with why it is one of our own typed errors. An
 * allowlist entry that no longer matches fails too, so it cannot go stale.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../../../..');
const DIRS = ['src/modules/accounting/services/sage-migration', 'scripts/sage-migration'];
const THROWN = '(?:err|e|error|reason|cause|raw|lost|failure|waited|lookupFailure|unlockFailure|rollback)';
const BANNED: Array<[string, RegExp]> = [
  ['String() of a thrown value', new RegExp(`\\bString\\(${THROWN}\\)`)],
  ['a .message / .code read of a thrown value', new RegExp(`\\b${THROWN}\\??\\.(?:message|code)\\b`)],
  ['a .code read through an errno / code cast', /\bas (?:NodeJS\.ErrnoException|\{ ?code\?: ?unknown ?\}[^)]*)\)\??\.code\b/],
  ['a thrown value in a template literal', new RegExp(`\\$\\{${THROWN}\\}`)],
];
/** [file, the text on the line, why it is safe]: our own typed errors, read after an instanceof of our class. */
const ALLOW: Array<[string, string, string]> = [
  ['runMain.ts', 'err instanceof RefusedStart ? err.message', 'RefusedStart: ours, its message a string we built'],
  ['sagePurchaseOrderParser.ts', 'for the PO date ${date}: ${err.message}', 'VatRateDateError, checked by instanceof on the line before'],
  ['sageMigrationRunner.ts', 'toolReported: null, error: err.message }]', 'BatchKeyHeldError | LockWaitError | StatementTimeoutError: ours, checked just before'],
  ['sageMigrationRunner.ts', "error: waited.message }", 'waited: the error above, or session.stall() (ours: LockWaitError | StatementTimeoutError)'],
];

const files = DIRS.flatMap((d) => readdirSync(join(ROOT, d)).filter((f) => f.endsWith('.ts')).map((f) => ({ dir: d, name: f })));
const codeOnly = (line: string) => line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '').replace(/^\s*\/\*\*.*$/, ''); // comments say what code did

describe('round 36: every unknown thrown value is read through sageTold.ts', () => {
  it('the census covers both trees', () => {
    expect(files.filter((f) => f.dir.startsWith('src')).length).toBeGreaterThan(30);
    expect(files.filter((f) => f.dir.startsWith('scripts')).length).toBeGreaterThanOrEqual(8);
  });
  it('no bare String() / .message / .code read of a thrown value outside sageTold.ts and the allowlist', () => {
    const hits: string[] = [];
    const used = new Set<number>();
    for (const f of files) {
      if (f.name === 'sageTold.ts') continue; // the one place that may
      readFileSync(join(ROOT, f.dir, f.name), 'utf8').split('\n').forEach((raw, i) => {
        const line = codeOnly(raw);
        for (const [what, re] of BANNED) {
          if (!re.test(line)) continue;
          const allowed = ALLOW.findIndex(([file, text]) => file === f.name && line.includes(text));
          if (allowed >= 0) { used.add(allowed); continue; }
          hits.push(`${f.dir}/${f.name}:${i + 1}: ${what}: ${raw.trim().slice(0, 140)}`);
        }
      });
    }
    expect(hits).toEqual([]);
    expect(ALLOW.filter((_, i) => !used.has(i)).map(([file, text]) => `${file}: ${text}`)).toEqual([]); // no stale entry
  });
});
