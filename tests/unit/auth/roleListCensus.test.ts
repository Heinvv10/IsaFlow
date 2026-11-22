/**
 * #1656 (Hein 2026-11-19: the app model wins): the role vocabulary is defined in ONE place,
 * src/lib/auth/companyRoles.ts. The admin platform had three lists of its own
 * (admin/accountant/bookkeeper/viewer, admin/manager/storeman/technician/viewer,
 * owner/accountant/viewer) beside the app's owner/admin/manager/viewer, and a user the portal
 * linked as a bookkeeper could not write anything in the app.
 *
 * Census over every tracked .ts/.tsx under src/ and pages/ (git ls-files): a sequence of two or
 * more string literals joined by `,` or `|` (an array, Set, z.enum, `.includes([...])` list or a
 * union type) is a role list when it holds `viewer`, or a legacy role (storeman, technician,
 * bookkeeper), together with any other role. A policy subset (['owner', 'admin'],
 * ['owner', 'admin', 'manager']) never holds the bottom role, so it is not a list of roles and
 * is not flagged. Known limit, accepted: an object keyed by roles (ROLE_HIERARCHY, APPROVER_RANK,
 * a badge-class map) is a per-role mapping, not a list, and is not read.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';

const SHARED_SOURCE = 'src/lib/auth/companyRoles.ts';
const ROLE_WORDS = new Set(['owner', 'admin', 'manager', 'viewer', 'storeman', 'technician', 'bookkeeper', 'accountant']);
const MARKERS = new Set(['viewer', 'storeman', 'technician', 'bookkeeper']);
/** Two or more quoted words joined by `,` or `|` (whitespace and newlines allowed between). */
const SEQUENCE = /(['"])[a-z_]+\1(?:\s*[,|]\s*(['"])[a-z_]+\2)+/g;

/** The role lists in `source`, each as its words (only sequences that are role lists). */
function roleLists(source: string): string[][] {
  const out: string[][] = [];
  for (const match of source.matchAll(SEQUENCE)) {
    const words = [...match[0].matchAll(/['"]([a-z_]+)['"]/g)].map((m) => m[1]!);
    const roles = words.filter((w) => ROLE_WORDS.has(w));
    if (roles.some((w) => MARKERS.has(w)) && new Set(roles).size >= 2) out.push(words);
  }
  return out;
}

const files = execFileSync('git', ['ls-files', 'src', 'pages'], { encoding: 'utf8' })
  .split('\n')
  .filter((f) => /\.(ts|tsx)$/.test(f) && f !== SHARED_SOURCE);

describe('role list census (#1656)', () => {
  it('the detector sees the shapes the old lists took, and leaves policy subsets alone', () => {
    expect(roleLists("const ROLES = ['owner', 'admin', 'manager', 'viewer'] as const;")).toHaveLength(1);
    expect(roleLists("z.enum(['admin', 'manager', 'storeman', 'technician', 'viewer', 'super_admin'])")).toHaveLength(1);
    expect(roleLists("type R = 'super_admin' | 'owner' | 'admin' | 'viewer';")).toHaveLength(1);
    expect(roleLists("role: 'owner' | 'accountant' | 'viewer';")).toHaveLength(1);
    expect(roleLists("!['admin', 'manager', 'viewer', 'storeman',\n 'technician'].includes(role)")).toHaveLength(1);
    expect(roleLists("allowedRoles: ['owner', 'admin']")).toEqual([]);
    expect(roleLists("const MERGE = ['owner', 'admin', 'manager'];")).toEqual([]);
    expect(roleLists("type SignupType = 'direct' | 'accountant';")).toEqual([]);
  });

  it('the shared source defines the lists (so the census has something to point at)', () => {
    expect(roleLists(readFileSync(SHARED_SOURCE, 'utf8')).length).toBeGreaterThan(0);
  });

  it('no file but src/lib/auth/companyRoles.ts writes a role list', () => {
    const offenders = files.flatMap((file) =>
      roleLists(readFileSync(file, 'utf8')).map((words) => `${file}: ${words.join(', ')}`));
    expect(offenders).toEqual([]);
  });
});
