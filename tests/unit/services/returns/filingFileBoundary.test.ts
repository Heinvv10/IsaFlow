/**
 * F23 (wave 6 grill): nothing in the e-filing files sends anything to SARS. The EFa (and EFb) modules and routes, and
 * everything they import, transitively, never reach the ISV client or its submission service; and their own source
 * holds no fetch(. EFb appends its files to OWN. Mutation: import sarsEfilingClient in filingFileService.ts (red).
 */
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../../../..');
const OWN = [
  'src/modules/accounting/services/returns/filingFileContent.ts',
  'src/modules/accounting/services/returns/filingFilePdf.ts',
  'src/modules/accounting/services/returns/filingFileService.ts',
  'src/modules/accounting/services/returns/filingReference.ts',
  'src/modules/accounting/services/returns/fileReturn.ts',
  'pages/api/accounting/sars/returns/[form]/filing-file.ts',
  'pages/api/accounting/sars/returns/[form]/file.ts',
  'src/components/accounting/sars/returns/FilingFileActions.tsx',
  // EFb (EMP501).
  'src/modules/accounting/services/returns/emp501FilingFile.ts',
  'src/modules/accounting/services/returns/emp501Figures.ts',
  'src/modules/accounting/services/returns/emp501Readiness.ts',
  'src/modules/accounting/services/returns/finaliseEmp501Return.ts',
  'src/modules/accounting/services/payroll/easyFileInput.ts',
  'pages/api/payroll/emp501/returns/index.ts',
  'pages/api/payroll/emp501/returns/filing-file.ts',
  'pages/api/payroll/irp5/easyfile-export.ts',
  'src/components/payroll/emp501/Emp501ReturnSection.tsx',
];
const FORBIDDEN = ['src/modules/accounting/services/reports/sarsEfilingClient.ts',
  'src/modules/accounting/services/reports/sarsEfilingSubmissionService.ts'];

/** A repo-relative import's file, or null for a package. */
function resolve(from: string, spec: string): string | null {
  const base = spec.startsWith('@/') ? path.join(ROOT, 'src', spec.slice(2))
    : spec.startsWith('.') ? path.resolve(path.dirname(from), spec) : null;
  if (!base) return null;
  for (const c of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
    if (existsSync(c) && !c.endsWith('/') && /\.tsx?$/.test(c)) return c;
  }
  return null;
}

/** `import … from 'x'`, `export … from 'x'`, a bare `import 'x'`, and `import('x')`. */
const IMPORT = /(?:import|export)\s[^'";]*?from\s+['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Every repo module reachable from the entry files (type-only imports included: stricter, never looser). */
function closure(entries: string[]): Set<string> {
  const seen = new Set<string>();
  const todo = entries.map((e) => path.join(ROOT, e));
  while (todo.length > 0) {
    const file = todo.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const m of readFileSync(file, 'utf8').matchAll(IMPORT)) {
      const next = resolve(file, m[1] ?? m[2] ?? m[3]!);
      if (next && !seen.has(next)) todo.push(next);
    }
  }
  return seen;
}

describe('F23: the e-filing files never send to SARS', () => {
  it('every listed module exists (a renamed file must be renamed here, not dropped)', () => {
    for (const f of OWN) expect(existsSync(path.join(ROOT, f)), f).toBe(true);
  });

  it('nothing they import, transitively, is the ISV client or its submission service', () => {
    const reached = [...closure(OWN)].map((f) => path.relative(ROOT, f));
    expect(reached.length).toBeGreaterThan(OWN.length); // the walk follows imports
    expect(reached.filter((f) => FORBIDDEN.includes(f))).toEqual([]);
  });

  it('their own source holds no fetch( and names neither module', () => {
    for (const f of OWN) {
      const src = readFileSync(path.join(ROOT, f), 'utf8');
      expect(src, f).not.toMatch(/\bfetch\s*\(/);
      expect(src, f).not.toMatch(/sarsEfilingClient|sarsEfilingSubmissionService/);
    }
  });
});
