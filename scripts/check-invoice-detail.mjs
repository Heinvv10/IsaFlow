const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJlbWFpbCI6ImFkbWluQGlzYWZsb3cuY28uemEiLCJyb2xlIjoic3VwZXJfYWRtaW4iLCJzZXNzaW9uSWQiOiI1NTEiLCJzdWIiOiJhZG1pbi0wMDEiLCJpYXQiOjE3NzU5Njc2NDAsImV4cCI6MTc3NjA1NDA0MH0.TQvprTMRAKeN--M9cEdFY27aLGfRgWVKKwxbXKIPSCY';
const CID = '00000000-0000-0000-0000-000000000001';
const BASE = 'https://app.isaflow.co.za';

async function apiGet(path) {
  const r = await fetch(`${BASE}${path}`, { headers: { 'Cookie': `ff_auth_token=${TOKEN}`, 'X-Company-Id': CID } });
  const text = await r.text();
  try { return { status: r.status, data: JSON.parse(text) }; }
  catch { return { status: r.status, data: null, raw: text.substring(0, 100) }; }
}

// Get the newly created invoice
const inv = await apiGet('/api/accounting/customer-invoices-detail?id=2e397b8f-c0ae-4fbc-8c48-49ad47f568a3');
const d = inv.data?.data || {};
console.log('Created invoice detail:');
console.log('  status:', d.status);
console.log('  subtotal:', d.subtotal);
console.log('  tax_amount:', d.tax_amount);
console.log('  total_amount:', d.total_amount);
console.log('  amount_paid:', d.amount_paid);

// VAT check
const sub = parseFloat(d.subtotal || 0);
const tax = parseFloat(d.tax_amount || 0);
const total = parseFloat(d.total_amount || 0);
console.log(`  VAT calc: ${sub} * 15% = ${(sub*0.15).toFixed(2)} actual=${tax.toFixed(2)} correct=${Math.abs(sub*0.15-tax)<0.02}`);
console.log(`  subtotal+tax=${(sub+tax).toFixed(2)} total=${total.toFixed(2)} match=${Math.abs(sub+tax-total)<0.02}`);

// Test PDF download
const pdf = await apiGet(`/api/accounting/invoice-pdf?id=2e397b8f-c0ae-4fbc-8c48-49ad47f568a3`);
console.log('PDF endpoint status:', pdf.status, 'error:', pdf.data?.error);

// Check what parameters PDF needs
const pdfWithParam = await fetch(`${BASE}/api/accounting/invoice-pdf?invoiceId=2e397b8f-c0ae-4fbc-8c48-49ad47f568a3`, {
  headers: { 'Cookie': `ff_auth_token=${TOKEN}`, 'X-Company-Id': CID }
});
console.log('PDF with invoiceId param:', pdfWithParam.status, pdfWithParam.headers.get('content-type'));

// Check customer-payments endpoint structure for recording payment
const pmts = await apiGet('/api/accounting/customer-payments');
console.log('Customer payments data:', Object.keys(pmts.data?.data || {}));
const pmtList = pmts.data?.data?.payments || [];
console.log('Payment count:', pmtList.length);
if (pmtList.length > 0) {
  console.log('Payment fields:', Object.keys(pmtList[0]).slice(0, 10).join(', '));
}

// Test: What does a valid POST to customer-payments look like?
const testPost = await fetch(`${BASE}/api/accounting/customer-payments`, {
  method: 'POST',
  headers: { 'Cookie': `ff_auth_token=${TOKEN}`, 'X-Company-Id': CID, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    clientId: 'f1000000-0000-0000-0000-000000000001',
    paymentDate: '2026-04-12',
    totalAmount: 1000,
    allocations: [{ invoiceId: '2e397b8f-c0ae-4fbc-8c48-49ad47f568a3', amount: 1000 }]
  })
});
const testBody = await testPost.json().catch(() => null);
console.log('POST customer-payments test:', testPost.status, testBody?.error || testBody?.data);

