import { neon } from '@neondatabase/serverless';

const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJlbWFpbCI6ImFkbWluQGlzYWZsb3cuY28uemEiLCJyb2xlIjoic3VwZXJfYWRtaW4iLCJzZXNzaW9uSWQiOiI1NTEiLCJzdWIiOiJhZG1pbi0wMDEiLCJpYXQiOjE3NzU5Njc2NDAsImV4cCI6MTc3NjA1NDA0MH0.TQvprTMRAKeN--M9cEdFY27aLGfRgWVKKwxbXKIPSCY';
const CID = '00000000-0000-0000-0000-000000000001';
const BASE = 'https://app.isaflow.co.za';

async function apiGet(path) {
  const r = await fetch(`${BASE}${path}`, {
    headers: { 'Cookie': `ff_auth_token=${TOKEN}`, 'X-Company-Id': CID }
  });
  const text = await r.text();
  try { return { status: r.status, data: JSON.parse(text) }; }
  catch { return { status: r.status, data: null, raw: text.substring(0, 100) }; }
}

const sql = neon('postgresql://neondb_owner:npg_TDuKN9ao1sZB@ep-shiny-flower-aldyej0o-pooler.c-3.eu-central-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require');

// W1: Customer invoices VAT check — get actual invoice with line items
const r1 = await apiGet('/api/accounting/customer-invoices-list?limit=3');
const invList = r1.data?.data?.invoices || r1.data?.data || [];
console.log('W1 Invoice statuses present:', [...new Set(invList.map(i => i.status||i.payment_status))].join(', '));
if (invList.length > 0) {
  const inv = invList[0];
  const sub = parseFloat(inv.subtotal || 0);
  const tax = parseFloat(inv.tax_amount || inv.taxAmount || 0);
  const total = parseFloat(inv.total_amount || inv.totalAmount || 0);
  const expectedVAT = sub * 0.15;
  console.log(`W1 Sample invoice: subtotal=${sub} tax=${tax} total=${total} expectedVAT=${expectedVAT.toFixed(2)} vatCorrect=${Math.abs(tax-expectedVAT)<1}`);
  
  // Check detail
  const invId = inv.id || inv.invoice_id;
  if (invId) {
    const detail = await apiGet(`/api/accounting/customer-invoices-detail?id=${invId}`);
    const d = detail.data?.data || {};
    console.log(`W1 Invoice detail fields: ${Object.keys(d).slice(0,12).join(', ')}`);
    // PDF
    const pdf = await apiGet(`/api/accounting/invoice-pdf?id=${invId}`);
    console.log(`W1 PDF for ${invId}: status=${pdf.status} type=${pdf.raw?.substring(0,50)||'json'}`);
  }
}

// W1: Record payment — find the endpoint
for (const ep of ['/api/accounting/customer-payments', '/api/accounting/record-customer-payment', '/api/accounting/payments/customer']) {
  const r = await apiGet(ep);
  if (r.status !== 404) console.log(`W2 Payment endpoint ${ep}: ${r.status} keys=[${Object.keys(r.data?.data||{}).slice(0,5).join(',')}]`);
}

// W2: Find payment list shape
const pmts = await apiGet('/api/accounting/customer-payments');
const pmtData = pmts.data?.data;
console.log('W2 Payments data type:', typeof pmtData, Array.isArray(pmtData) ? `array[${pmtData.length}]` : Object.keys(pmtData||{}).slice(0,5).join(','));

// W3: Supplier invoice VAT check
const r3 = await apiGet('/api/accounting/supplier-invoices?limit=3');
const supList = r3.data?.data?.invoices || r3.data?.data || [];
if (supList.length > 0) {
  const s = supList[0];
  const sub = parseFloat(s.subtotal || 0);
  const tax = parseFloat(s.tax_amount || s.taxAmount || 0);
  const total = parseFloat(s.total_amount || s.totalAmount || 0);
  console.log(`W3 Sample supplier inv: subtotal=${sub} tax=${tax} total=${total} vatOK=${Math.abs(sub*0.15-tax)<1}`);
}

// W4: Bank account structure
const banks = await apiGet('/api/accounting/bank-accounts');
const bankList = banks.data?.data || [];
if (bankList.length > 0) {
  const b = bankList[0];
  console.log(`W4 Bank account fields: ${Object.keys(b).slice(0,10).join(', ')}`);
  const bankId = b.id || b.bank_account_id;
  if (bankId) {
    const txns = await apiGet(`/api/accounting/bank-transactions?bank_account_id=${bankId}&limit=5`);
    const txnList = txns.data?.data?.transactions || txns.data?.data || [];
    console.log(`W4 Transactions for bank ${bankId}: status=${txns.status} count=${txnList.length}`);
    if (txnList.length > 0) console.log(`W4 Txn fields: ${Object.keys(txnList[0]).slice(0,10).join(', ')}`);
  }
}

// W5: CoA structure
const coa = await apiGet('/api/accounting/chart-of-accounts');
const coaList = coa.data?.data || [];
if (coaList.length > 0) {
  const acc = coaList[0];
  console.log(`W5 CoA fields: ${Object.keys(acc).slice(0,10).join(', ')}`);
  console.log(`W5 Account types: ${[...new Set(coaList.map(a => a.account_type))].slice(0,8).join(', ')}`);
}

// W6: Fiscal periods
const periods = await sql`SELECT id, period_name, start_date, end_date FROM fiscal_periods WHERE company_id = ${CID} ORDER BY start_date DESC LIMIT 3`;
console.log('W6 Fiscal periods:', periods.map(p => `${p.period_name}(${p.id})`).join(', '));
if (periods.length > 0) {
  const tb = await apiGet(`/api/accounting/reports-trial-balance?fiscal_period_id=${periods[0].id}`);
  const d = tb.data?.data || {};
  const dr = parseFloat(d.totalDebit || 0);
  const cr = parseFloat(d.totalCredit || 0);
  console.log(`W6 Trial Balance: status=${tb.status} debit=${dr.toFixed(2)} credit=${cr.toFixed(2)} balanced=${Math.abs(dr-cr)<0.02} rows=${d.accounts?.length||0}`);
}

// W7: VAT return endpoints
for (const params of ['period=2026-01', 'from=2026-01-01&to=2026-03-31', 'year=2026&period=Q1']) {
  const r = await apiGet(`/api/accounting/reports-vat-return?${params}`);
  if (r.status !== 404) {
    const d = r.data?.data || {};
    console.log(`W7 VAT (${params}): status=${r.status} outputVat=${d.outputVat||d.output_vat||'?'} inputVat=${d.inputVat||d.input_vat||'?'} netVat=${d.netVat||d.net_vat||d.netPayable||'?'}`);
    break;
  }
}

// W8: UDF fields
const udf = await apiGet('/api/accounting/udf-fields');
const udfList = udf.data?.data || [];
console.log(`W8 UDF Fields: status=${udf.status} count=${Array.isArray(udfList) ? udfList.length : 'not-array'}`);
if (Array.isArray(udfList) && udfList.length > 0) {
  console.log(`W8 UDF sample: ${Object.keys(udfList[0]).join(', ')}`);
}

// Company settings
const cs = await apiGet('/api/accounting/company-settings');
const csd = cs.data?.data || {};
console.log(`W8 Company settings: status=${cs.status} keys=[${Object.keys(csd).slice(0,8).join(',')}]`);

