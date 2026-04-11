/**
 * Test the bank statement import security gate end-to-end.
 *
 * Scenario 1 (expect 403 MISMATCH):
 *   Import real Brighttech PDF into the "QA Test Account" (number
 *   9999000001). The parser now extracts 4069625895 from the PDF
 *   header so the gate should reject.
 *
 * Scenario 2 (expect 201/200 SUCCESS):
 *   Import the same PDF into the real Brightsphere account (number
 *   4069625895). The match should succeed and the import proceed.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const envPath = '/home/hein/Workspace/IsaFlow/.env.local';
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, k, rawV] = m;
    if (!process.env[k!]) process.env[k!] = rawV!.replace(/^["']|["']$/g, '');
  }
}

const BASE = 'http://localhost:3200';
const QA_TEST_ACCOUNT = 'f1b8b750-5a38-4fff-8abc-c85d374e03fb'; // number: 9999000001
const BRIGHTTECH_ACCOUNT = '1536f992-6e0e-421b-8770-c62a3ace67c4'; // number: 4069625895

async function login(): Promise<string> {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'qa-onboard-05@isaflow.test', password: 'QaOnboard!2026' }),
  });
  if (!r.ok) throw new Error(`Login failed: ${r.status}`);
  const cookies = r.headers.getSetCookie?.() ?? [];
  return cookies.map(c => c.split(';')[0]).join('; ');
}

async function runImport(label: string, cookie: string, bankAccountId: string, pdfBase64: string) {
  console.log(`\n=== ${label} ===`);
  console.log(`  bankAccountId = ${bankAccountId}`);
  const r = await fetch(`${BASE}/api/accounting/bank-transactions-import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      pdfBase64,
      bankAccountId,
      statementDate: '2024-01-29',
      fileType: 'pdf',
    }),
  });
  const bodyText = await r.text();
  let body: unknown = bodyText;
  try { body = JSON.parse(bodyText); } catch {}
  console.log(`  HTTP ${r.status}`);
  console.log(`  body: ${JSON.stringify(body, null, 2).slice(0, 500)}`);
  return r.status;
}

async function main() {
  const cookie = await login();
  console.log('✓ Logged in as qa-onboard-05@isaflow.test');

  const pdfBuffer = fs.readFileSync(path.resolve('/home/hein/Workspace/IsaFlow/test-docs/bank-statements/stmt_196.pdf'));
  const pdfBase64 = pdfBuffer.toString('base64');
  console.log(`✓ PDF loaded: ${pdfBuffer.length} bytes`);

  // Test 1: wrong account → expect 403
  const s1 = await runImport(
    'Test 1: import into WRONG account (9999000001) — expect 403',
    cookie, QA_TEST_ACCOUNT, pdfBase64,
  );

  // Test 2: right account → expect 201 (or 200) with parse result
  const s2 = await runImport(
    'Test 2: import into CORRECT account (4069625895) — expect success',
    cookie, BRIGHTTECH_ACCOUNT, pdfBase64,
  );

  console.log('\n=== Summary ===');
  const wrong_ok = s1 === 403;
  const right_ok = s2 >= 200 && s2 < 300;
  console.log(`  Test 1 (mismatch → 403): ${wrong_ok ? '✅ PASS' : '❌ FAIL (got ' + s1 + ')'}`);
  console.log(`  Test 2 (match → 2xx):    ${right_ok ? '✅ PASS' : '❌ FAIL (got ' + s2 + ')'}`);

  process.exit(wrong_ok && right_ok ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
