import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Finding } from './types';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = path.resolve(HERE, '..', '..', 'qa-reports');

export function writeHttpReports(
  findings: Finding[],
  summary: { pass: number; fail: number; info: number; blocked: number },
  baseUrl: string,
  companyId: string,
): { json: string; md: string } {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const json = path.join(REPORTS_DIR, `cycle2-http-${ts}.json`);
  const md = path.join(REPORTS_DIR, `cycle2-http-${ts}.md`);

  fs.writeFileSync(json, JSON.stringify({
    timestamp: ts, base_url: baseUrl, company_id: companyId, summary, findings,
  }, null, 2));

  const lines: string[] = [];
  lines.push(`# Cycle 2 — HTTP walkthrough — IsaDemo2`);
  lines.push(`**Base:** ${baseUrl}`);
  lines.push(`**Tenant:** \`${companyId}\``);
  lines.push(`**Run:** ${ts}`);
  lines.push('');
  lines.push(`## Summary`);
  lines.push(`- PASS: ${summary.pass}`);
  lines.push(`- FAIL: ${summary.fail}`);
  lines.push(`- INFO: ${summary.info}`);
  lines.push(`- BLOCKED: ${summary.blocked}`);
  lines.push('');
  lines.push('## Findings');
  for (const f of findings) {
    lines.push(`### [${f.verdict}] \`${f.journey}/${f.step}\``);
    lines.push(`- **${f.request.method}** \`${f.request.url}\` → HTTP ${f.response.status}`);
    if (f.request.body) lines.push(`- Request body: \`${JSON.stringify(f.request.body).slice(0, 300)}\``);
    lines.push(`- **Expected:** ${f.expected}`);
    lines.push(`- **Actual:** ${f.actual}`);
    if (f.audit_claim) lines.push(`- **Audit claim:** ${f.audit_claim}`);
    lines.push(`- **Response (truncated):** \`${JSON.stringify(f.response.body).slice(0, 500)}\``);
    lines.push('');
  }
  fs.writeFileSync(md, lines.join('\n'));
  return { json, md };
}
