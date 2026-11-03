/**
 * Every source file that INSERTs into or UPDATEs payroll_employee_components is on this list. A new writer has to
 * decide there which guard it takes (paid months, overlap, the company lock) before it can land: the writers kept
 * drifting apart (a once-off judged one way in assign, another in Edit dates). The table is read per statement, so a
 * file that writes another table in the same breath is not mistaken for one.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const ROOT = new URL('../../../../', import.meta.url).pathname;
const SERVICES = 'src/modules/accounting/services/payroll/';

/** file -> the guard it carries. */
const WRITERS: Record<string, string> = {
  [`${SERVICES}payrollEmployeeComponentService.ts`]: 'assign: refuseAssignmentWrite under the company lock',
  [`${SERVICES}payrollBatchPost.ts`]: 'batch post: refuseAssignmentWrite under the company lock',
  [`${SERVICES}payPackageService.ts`]: 'package apply: refuseAssignmentWrite under the company lock',
  [`${SERVICES}payPackageSupersede.ts`]: 'package apply cut: paidPeriodChanged under the company lock',
  [`${SERVICES}payrollComponentDateEdit.ts`]: 'Edit dates / End: paid months and overlap under the company lock',
};

const STATEMENT = /\b(INSERT\s+INTO|UPDATE)\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi;

function writersOf(file: string): number {
  let n = 0;
  for (const m of readFileSync(ROOT + file, 'utf8').matchAll(STATEMENT)) if (m[2]!.toLowerCase() === 'payroll_employee_components') n += 1;
  return n;
}

describe('writers of payroll_employee_components', () => {
  const tracked = execFileSync('git', ['ls-files', 'src', 'pages', 'scripts'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter((f) => /\.(ts|tsx|js|mjs)$/.test(f) && !f.startsWith('scripts/migrations/'));

  it('are exactly the listed files', () => {
    const found = tracked.filter((f) => writersOf(f) > 0).sort();
    expect(found).toEqual(Object.keys(WRITERS).sort());
  });

  it('the census reads the table per statement', () => {
    const sample = 'INSERT INTO payroll_employee_audit (a) VALUES (1); UPDATE payroll_employee_components SET x = 1';
    expect([...sample.matchAll(STATEMENT)].map((m) => m[2])).toEqual(['payroll_employee_audit', 'payroll_employee_components']);
  });
});
