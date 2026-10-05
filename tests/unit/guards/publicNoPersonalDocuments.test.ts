/**
 * Everything under public/ is served by Next.js to anyone, with no login.
 * Real Blitz Fibre payroll documents (payslips, pay register, EMP201, UIF
 * submission) sat in public/Payroll Docs/ from 2026-04-12 until 2026-10-05
 * and were downloadable from production. This guard fails the build if any
 * document file, or anything named like payroll or tax paperwork, is put back.
 * It walks the directory on disk (what deploy.sh copies), not the git index.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const PUBLIC_DIR = join(process.cwd(), 'public');
const DOCUMENT_EXT = /\.(pdf|docx?|xlsx?|csv|zip)$/i;
const SENSITIVE_NAME = /payslip|payroll|pay[-_ ]?register|emp20|emp501|irp5|it3|uif|remuneration|salar|leave|bank[-_ ]?statement|id[-_ ]?doc/i;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? [full, ...walk(full)] : [full];
  });
}

describe('public/ serves no personal or payroll documents', () => {
  const paths = walk(PUBLIC_DIR).map((p) => relative(PUBLIC_DIR, p));

  it('walked the real public directory', () => {
    expect(paths.length).toBeGreaterThan(5);
  });

  it('holds no document files', () => {
    expect(paths.filter((p) => DOCUMENT_EXT.test(p))).toEqual([]);
  });

  it('holds nothing named like payroll or tax paperwork', () => {
    expect(paths.filter((p) => SENSITIVE_NAME.test(p))).toEqual([]);
  });
});
