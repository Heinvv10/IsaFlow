/**
 * check-no-recent-changes — no `## Recent changes` section in any agent doc, and no line added to a frozen
 * `CHANGES-ARCHIVE.md` that already exists on origin/master (an archive created in this branch is new, so fine).
 * The rule lives in ./noRecentChangesRule.ts.
 *
 * Run: bun scripts/ci/check-no-recent-changes.ts
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { findArchiveAppends, findRecentChangesHeadings, isAgentDoc, parseNumstat } from './noRecentChangesRule';

const BASE = 'origin/master';
const git = (...args: string[]): string => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const errors: string[] = [];
try {
  const tracked = git('ls-files', '-z').split('\0').filter((p) => p !== '' && isAgentDoc(p));
  errors.push(...findRecentChangesHeadings(tracked.map((path) => ({ path, text: readFileSync(path, 'utf8') }))));

  // --diff-filter=M: only archives that exist on the base. Added files (new archives) are not compared.
  const modified = git('diff', '--numstat', '--diff-filter=M', `${BASE}...HEAD`, '--', '**/CHANGES-ARCHIVE.md', 'CHANGES-ARCHIVE.md');
  errors.push(...findArchiveAppends(parseNumstat(modified)));
} catch (err) {
  errors.push(`could not run the check (is ${BASE} fetched?): ${(err as Error).message}`);
}

if (errors.length) {
  process.stderr.write(`ERROR: agent docs hold rules only:\n${errors.map((e) => `  - ${e}`).join('\n')}\n`);
  process.exit(1);
}
process.stdout.write('no "Recent changes" section in any agent doc; no line added to an existing CHANGES-ARCHIVE.md\n');
