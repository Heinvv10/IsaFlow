import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Finding } from './types';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = path.resolve(HERE, '..', '..', 'qa-reports');

export function writeReports(
  findings: Finding[],
  summary: { pass: number; fail: number; info: number; blocked: number },
  companyId: string,
): { json: string; md: string } {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });

  const json = path.join(REPORTS_DIR, `run-${ts}.json`);
  const md = path.join(REPORTS_DIR, `run-${ts}.md`);

  fs.writeFileSync(json, JSON.stringify({
    timestamp: ts,
    company_id: companyId,
    tenant: 'IsaDemo2',
    summary,
    findings,
  }, null, 2));

  const lines: string[] = [];
  lines.push(`# QA Walkthrough — IsaDemo2`);
  lines.push(`**Tenant:** IsaDemo2 (\`${companyId}\`)`);
  lines.push(`**Run:** ${ts}`);
  lines.push('');
  lines.push(`## Summary`);
  lines.push(`- PASS: ${summary.pass}`);
  lines.push(`- FAIL: ${summary.fail}`);
  lines.push(`- INFO: ${summary.info}`);
  lines.push(`- BLOCKED: ${summary.blocked}`);
  lines.push('');
  lines.push(`## Findings`);
  for (const f of findings) {
    lines.push(`### [${f.verdict}] \`${f.journey}/${f.step}\``);
    lines.push(`- **Expected:** ${f.expected}`);
    lines.push(`- **Actual:** ${f.actual}`);
    if (f.audit_claim) lines.push(`- **Audit claim being verified:** ${f.audit_claim}`);
    if (f.evidence) lines.push(`- **Evidence:** \`${JSON.stringify(f.evidence)}\``);
    lines.push('');
  }
  fs.writeFileSync(md, lines.join('\n'));
  return { json, md };
}
