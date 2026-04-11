/**
 * Test the bank statement import security gate end-to-end via direct HTTP.
 *
 * Logs in as qa-onboard-05, then POSTs the real Brighttech PDF statement
 * with our deliberately-wrong bank account ID. Expect HTTP 403 from the
 * new account-match gate.
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
const BANK_ACCOUNT_ID = 'f1b8b750-5a38-4fff-8abc-c85d374e03fb'; // stored number = 9999000001

async function main() {
  // 1. Login as qa-onboard-05
  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'qa-onboard-05@isaflow.test', password: 'QaOnboard!2026' }),
  });
  if (!loginRes.ok) {
    console.error('Login failed:', loginRes.status, await loginRes.text());
    process.exit(1);
  }
  const cookies = loginRes.headers.getSetCookie?.() ?? [];
  const cookieHeader = cookies.map(c => c.split(';')[0]).join('; ');
  console.log(`✓ Logged in; ${cookies.length} cookies captured`);

  // 2. Read the Brighttech PDF
  const pdfPath = path.resolve('/home/hein/Workspace/IsaFlow/test-docs/bank-statements/stmt_196.pdf');
  const pdfBuffer = fs.readFileSync(pdfPath);
  const pdfBase64 = pdfBuffer.toString('base64');
  console.log(`✓ PDF loaded: ${pdfBuffer.length} bytes, ${pdfBase64.length} base64 chars`);

  // 3. POST to the import endpoint
  console.log('\n→ Sending PDF to /api/accounting/bank-transactions-import...');
  console.log(`  bankAccountId = ${BANK_ACCOUNT_ID} (stored number: 9999000001)`);
  console.log(`  statement:    Brighttech real statement (account # will come from PDF header)`);
  console.log(`  expected:     403 Forbidden with "belongs to a different bank account" message\n`);

  const importRes = await fetch(`${BASE}/api/accounting/bank-transactions-import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
    body: JSON.stringify({
      pdfBase64,
      bankAccountId: BANK_ACCOUNT_ID,
      statementDate: '2024-01-29',
      fileType: 'pdf',
    }),
  });
  const bodyText = await importRes.text();
  let body: unknown = bodyText;
  try { body = JSON.parse(bodyText); } catch {}

  console.log(`← HTTP ${importRes.status} ${importRes.ok ? 'OK' : 'FAIL'}`);
  console.log(JSON.stringify(body, null, 2).slice(0, 1000));

  if (importRes.status === 403) {
    console.log('\n✅ PASS — Gate blocked the mismatched import as expected');
    process.exit(0);
  } else if (importRes.status === 201 || importRes.status === 200) {
    console.log('\n⚠️  Gate allowed the import — check if extractAccountNumber found anything');
    process.exit(1);
  } else {
    console.log('\n? Unexpected status');
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
