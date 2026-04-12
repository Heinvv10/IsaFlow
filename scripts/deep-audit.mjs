import { neon } from '@neondatabase/serverless';

const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJlbWFpbCI6ImFkbWluQGlzYWZsb3cuY28uemEiLCJyb2xlIjoic3VwZXJfYWRtaW4iLCJzZXNzaW9uSWQiOiI1NTEiLCJzdWIiOiJhZG1pbi0wMDEiLCJpYXQiOjE3NzU5Njc2NDAsImV4cCI6MTc3NjA1NDA0MH0.TQvprTMRAKeN--M9cEdFY27aLGfRgWVKKwxbXKIPSCY';
const CID = '00000000-0000-0000-0000-000000000001';
const BASE = 'https://app.isaflow.co.za';

async function apiGet(path) {
  const r = await fetch(`${BASE}${path}`, {
    headers: { 'Cookie': `ff_auth_token=${TOKEN}`, 'X-Company-Id': CID }
  });
  const text = await r.text();
  try {
    return { status: r.status, data: JSON.parse(text) };
  } catch {
    return { status: r.status, data: null, raw: text.substring(0, 200) };
  }
}

async function check(label, path, extractor) {
  try {
    const result = await apiGet(path);
    const info = extractor ? extractor(result) : `status=${result.status}`;
    console.log(`${label}: ${info}`);
  } catch(e) {
    console.log(`${label}: ERROR ${e.message}`);
  }
}

// W1: Customer list
await check('W1 Customers', '/api/accounting/customers-list', r => {
  const list = r.data?.data || [];
  return `status=${r.status} count=${list.length} first="${list[0]?.name || list[0]?.company_name || '?'}"`;
});

// W1: Customer invoices
await check('W1 Customer Invoices', '/api/accounting/customer-invoices-list', r => {
  const list = r.data?.data?.invoices || r.data?.data || [];
  const sample = list[0] || {};
  const subtotal = sample.subtotal || 0;
  const tax = sample.tax_amount || sample.taxAmount || 0;
  const total = sample.total_amount || sample.totalAmount || 0;
  const vatOk = subtotal > 0 ? Math.abs(parseFloat(subtotal) * 0.15 - parseFloat(tax)) < 1 : 'N/A';
  return `status=${r.status} count=${list.length} statuses=[${[...new Set(list.map(i => i.status||i.payment_status))].join(',')}] vatCheck=${vatOk}`;
});

// W1: PDF endpoint discovery
for (const path of ['/api/accounting/invoice-pdf', '/api/accounting/customer-invoice-pdf', '/api/accounting/invoices/pdf']) {
  const r = await apiGet(`${path}?id=test`);
  if (r.status !== 404) console.log(`W1 PDF endpoint found: ${path} status=${r.status}`);
  else console.log(`W1 PDF ${path}: 404`);
}

// W2: Record payment
await check('W2 Customer Payments', '/api/accounting/customer-payments', r => {
  const list = r.data?.data || [];
  return `status=${r.status} count=${list.length}`;
});

// Check record-payment endpoint
const rpCheck = await apiGet('/api/accounting/record-customer-payment');
console.log(`W2 Record Payment endpoint: ${rpCheck.status} (GET probe)`);

// W3: Supplier invoices
await check('W3 Supplier Invoices', '/api/accounting/supplier-invoices', r => {
  const list = r.data?.data?.invoices || r.data?.data || [];
  const sample = list[0] || {};
  return `status=${r.status} count=${list.length} statuses=[${[...new Set(list.map(i => i.status||i.payment_status).slice(0,5))].join(',')}]`;
});

// W4: Bank accounts
await check('W4 Bank Accounts', '/api/accounting/bank-accounts', r => {
  const list = r.data?.data || [];
  return `status=${r.status} count=${list.length} names=[${list.slice(0,3).map(b => b.bank_name || b.name).join(',')}]`;
});

// W4: Bank transactions
await check('W4 Bank Transactions', '/api/accounting/bank-transactions?limit=5', r => {
  const list = r.data?.data?.transactions || r.data?.data || [];
  return `status=${r.status} count=${list.length}`;
});

// W5: CoA
await check('W5 Chart of Accounts', '/api/accounting/chart-of-accounts', r => {
  const list = r.data?.data || [];
  return `status=${r.status} count=${list.length} types=[${[...new Set(list.slice(0,10).map(a => a.account_type))].join(',')}]`;
});

// W6: Trial Balance (find a valid fiscal period first)
const sql = neon('postgresql://neondb_owner:npg_TDuKN9ao1sZB@ep-shiny-flower-aldyej0o-pooler.c-3.eu-central-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require');
const periods = await sql`SELECT id, name FROM fiscal_periods WHERE company_id = ${CID} ORDER BY start_date DESC LIMIT 3`;
console.log('W6 Fiscal periods:', periods.map(p => `${p.name}:${p.id}`).join(', '));

if (periods.length > 0) {
  await check(`W6 Trial Balance (${periods[0].name})`, `/api/accounting/reports-trial-balance?fiscal_period_id=${periods[0].id}`, r => {
    const d = r.data?.data || {};
    const dr = parseFloat(d.totalDebit || 0);
    const cr = parseFloat(d.totalCredit || 0);
    const diff = Math.abs(dr - cr);
    return `status=${r.status} debit=${dr.toFixed(2)} credit=${cr.toFixed(2)} balanced=${diff < 0.02} diff=${diff.toFixed(2)}`;
  });
}

// W7: VAT return
await check('W7 VAT Return (2026-Q1)', '/api/accounting/reports-vat-return?period=2026-01', r => {
  const d = r.data?.data || {};
  return `status=${r.status} outputVAT=${d.outputVat||d.output_vat||d.outputTax||'N/A'} inputVAT=${d.inputVat||d.input_vat||d.inputTax||'N/A'} netVAT=${d.netVat||d.net_vat||d.netTax||'N/A'}`;
});
await check('W7 VAT Return (2026-Q1 alt)', '/api/accounting/reports-vat-return?from=2026-01-01&to=2026-03-31', r => {
  const d = r.data?.data || {};
  return `status=${r.status} keys=[${Object.keys(d).slice(0,8).join(',')}]`;
});

// W8: Company settings
await check('W8 Company Settings', '/api/accounting/company-settings', r => {
  const d = r.data?.data || {};
  return `status=${r.status} keys=[${Object.keys(d).slice(0,8).join(',')}]`;
});
await check('W8 UDF Fields', '/api/accounting/udf-fields', r => {
  const list = r.data?.data || [];
  return `status=${r.status} count=${list.length}`;
});
await check('W8 UDF Fields (entity=customer)', '/api/accounting/udf-fields?entity=customer', r => {
  const list = r.data?.data || [];
  return `status=${r.status} count=${list.length}`;
});

