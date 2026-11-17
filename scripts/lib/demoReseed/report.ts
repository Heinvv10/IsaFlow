/** How the run prints its counts and post-check results (one writer, the program's output). */

import { renderResult, summarize } from '../integrityTypes';
import type { PostCheckReport } from './postCheck';

export function renderCounts(verb: string, counts: ReadonlyArray<{ table: string; n: number }>, out: (s: string) => void): void {
  const nonZero = counts.filter((c) => c.n > 0);
  const total = nonZero.reduce((s, c) => s + c.n, 0);
  out(`${verb}: ${total} row(s) in ${nonZero.length} table(s)`);
  for (const c of nonZero) out(`  ${verb} ${c.table}: ${c.n}`);
}

export function renderReport(report: PostCheckReport, out: (s: string) => void): void {
  out('');
  out('== Demo post-checks ==');
  for (const r of report.demo) renderResult(r, out);
  out('');
  out('== Deploy integrity checks (scripts/lib/integrityChecks*.ts) ==');
  for (const r of report.deploy) renderResult(r, out);
  const d = summarize(report.demo);
  const g = summarize(report.deploy);
  out('');
  out(`summary: demo ${d.passed}/${d.total} passed, deploy ${g.passed}/${g.total} passed, deploy regressions ${report.regressed.length}`);
  for (const r of report.regressed) out(`  REGRESSED: ${r.label}`);
}
