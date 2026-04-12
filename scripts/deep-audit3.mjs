const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJlbWFpbCI6ImFkbWluQGlzYWZsb3cuY28uemEiLCJyb2xlIjoic3VwZXJfYWRtaW4iLCJzZXNzaW9uSWQiOiI1NTEiLCJzdWIiOiJhZG1pbi0wMDEiLCJpYXQiOjE3NzU5Njc2NDAsImV4cCI6MTc3NjA1NDA0MH0.TQvprTMRAKeN--M9cEdFY27aLGfRgWVKKwxbXKIPSCY';
const CID = '00000000-0000-0000-0000-000000000001';
const BASE = 'https://app.isaflow.co.za';

async function apiGet(path) {
  const r = await fetch(`${BASE}${path}`, { headers: { 'Cookie': `ff_auth_token=${TOKEN}`, 'X-Company-Id': CID } });
  const text = await r.text();
  try { return { status: r.status, data: JSON.parse(text) }; }
  catch { return { status: r.status, data: null, raw: text.substring(0, 300) }; }
}

// W1: Invoice with non-zero subtotal
const r1 = await apiGet('/api/accounting/customer-invoices-list?limit=50');
const invAll = r1.data?.data?.invoices || r1.data?.data || [];
const invWithSub = invAll.find(i => parseFloat(i.subtotal||0) > 0);
if (invWithSub) {
  const sub = parseFloat(invWithSub.subtotal);
  const tax = parseFloat(invWithSub.tax_amount || invWithSub.taxAmount || 0);
  const total = parseFloat(invWithSub.total_amount || invWithSub.totalAmount || 0);
  console.log(`W1 VAT-bearing invoice: sub=${sub.toFixed(2)} tax=${tax.toFixed(2)} total=${total.toFixed(2)} 15%=${(sub*0.15).toFixed(2)} vatOK=${Math.abs(sub*0.15-tax)<1}`);
} else {
  console.log('W1 All invoices have subtotal=0, total may be pre-calculated without subtotal split');
  // Check what status the invoices have
  const statusCounts = {};
  invAll.forEach(i => { const s = i.status||'?'; statusCounts[s] = (statusCounts[s]||0)+1; });
  console.log('W1 Status breakdown:', JSON.stringify(statusCounts));
}

// W1: Invoice detail with PDF
const firstInvId = invAll[0]?.id;
if (firstInvId) {
  const detail = await apiGet(`/api/accounting/customer-invoices-detail?id=${firstInvId}`);
  const d = detail.data?.data || {};
  console.log(`W1 Invoice ${firstInvId} detail: status=${detail.status} payment_status=${d.status} amount_paid=${d.amount_paid} total=${d.total_amount}`);
  
  // Test PDF
  const pdfR = await apiGet(`/api/accounting/invoice-pdf?id=${firstInvId}`);
  console.log(`W1 PDF status=${pdfR.status} error=${pdfR.data?.error?.message || pdfR.data?.error?.code || '?'}`);
}

// W2: Record payment — POST test
const pmtPost = await fetch(`${BASE}/api/accounting/customer-payments`, {
  method: 'POST',
  headers: { 'Cookie': `ff_auth_token=${TOKEN}`, 'X-Company-Id': CID, 'Content-Type': 'application/json' },
  body: JSON.stringify({ invoiceId: 'test-id', amount: 100, paymentDate: '2026-04-12', paymentMethod: 'bank' })
});
const pmtBody = await pmtPost.json().catch(() => null);
console.log(`W2 POST customer-payments: status=${pmtPost.status} error=${pmtBody?.error?.message||'?'}`);

// W6: Trial balance for a period with data
const tbCurrent = await apiGet('/api/accounting/reports-trial-balance?fiscal_period_id=72bab99e-fc80-4648-b3fc-845e54745062');
const tbd = tbCurrent.data?.data || {};
console.log(`W6 TB (hardcoded period): status=${tbCurrent.status} debit=${tbd.totalDebit} credit=${tbd.totalCredit} rows=${tbd.accounts?.length}`);

// Try without period
const tbNoPeriod = await apiGet('/api/accounting/reports-trial-balance');
console.log(`W6 TB (no period): status=${tbNoPeriod.status} error=${tbNoPeriod.data?.error?.message||'?'}`);

// W7: VAT return error details
const vatR = await apiGet('/api/accounting/reports-vat-return?period=2026-01');
console.log(`W7 VAT error: ${JSON.stringify(vatR.data?.error)}`);
const vatR2 = await apiGet('/api/accounting/reports-vat-return');
console.log(`W7 VAT no params: status=${vatR2.status} keys=${Object.keys(vatR2.data?.data||{}).slice(0,8).join(',')}`);

// W8: Company settings error
const csR = await apiGet('/api/accounting/company-settings');
console.log(`W8 CS error: status=${csR.status} ${JSON.stringify(csR.data?.error)}`);
// Try as GET
const csR2 = await fetch(`${BASE}/api/accounting/company-settings`, {
  method: 'GET',
  headers: { 'Cookie': `ff_auth_token=${TOKEN}`, 'X-Company-Id': CID, 'Accept': 'application/json' }
});
const csBody = await csR2.json().catch(() => null);
console.log(`W8 CS GET explicit: status=${csR2.status} keys=${Object.keys(csBody?.data||{}).slice(0,8).join(',')}`);

// W8: UDF — check correct endpoint name
for (const ep of ['/api/accounting/udf-fields', '/api/accounting/custom-fields', '/api/accounting/user-defined-fields', '/api/accounting/udf']) {
  const r = await apiGet(ep);
  if (r.status !== 404) console.log(`W8 UDF endpoint ${ep}: status=${r.status}`);
}

// Check the page itself renders (via a page route test)
console.log('\n--- PAGE ROUTES ---');
for (const path of [
  '/accounting/customers',
  '/accounting/customer-invoices/new',
  '/accounting/supplier-invoices/new',
  '/accounting/bank-accounts',
  '/accounting/chart-of-accounts',
  '/accounting/reports/trial-balance',
  '/accounting/reports/vat-return',
  '/accounting/company-settings',
]) {
  const r = await fetch(`${BASE}${path}`, {
    headers: { 'Cookie': `ff_auth_token=${TOKEN}`, 'X-Company-Id': CID },
    redirect: 'follow'
  });
  const text = await r.text();
  const is404 = text.includes('"statusCode":404') || text.includes('"statusCode": 404');
  const is500 = text.includes('Internal Server Error') || text.includes('statusCode":500');
  const isLogin = r.url.includes('/login');
  console.log(`${path}: HTTP=${r.status} final_url=${r.url.replace(BASE,'')} 404=${is404} 500=${is500} redirectedToLogin=${isLogin}`);
}

