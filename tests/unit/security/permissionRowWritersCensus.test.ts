/**
 * #1656 round 7 (breaker M4): company_user_permissions holds what Approve and Payroll are enforced from, so no app role may write it
 * (migration 1010d). Census over src, pages and scripts: the only code that writes it is memberWrites.ts (migration_admin pool, owner /
 * admin checked) and the admin portal's service (platform_admin, withAdmin). A third writer would hit 42501 on every app pool.
 * The shell scripts and migrations (which run as the deploy role) are not code that serves a request.
 */
import { describe, expect, it } from 'vitest';
import { sourceFiles, stripComments } from '../helpers/sourceCensus';

const WRITE = /\b(?:INSERT\s+INTO|DELETE\s+FROM|UPDATE|TRUNCATE(?:\s+TABLE)?)\s+(?:public\.)?company_user_permissions\b/i;

describe('company_user_permissions has exactly two writers', () => {
  it('memberWrites.ts and companyMembershipService.ts, nothing else in the served code', () => {
    const writers = sourceFiles()
      .filter((f) => /^(src|pages)\//.test(f.file) && /\.tsx?$/.test(f.file))
      .filter((f) => WRITE.test(stripComments(f.text, f.file)))
      .map((f) => f.file)
      .sort();
    expect(writers).toEqual([
      'src/modules/accounting/services/core/memberWrites.ts',
      'src/modules/admin/services/companyMembershipService.ts',
    ]);
  });
});
