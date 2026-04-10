/**
 * ISAFlow Competitive Comparison PDF Generator
 * Generates a professional branded PDF: ISAFlow vs Sage vs QuickBooks vs Xero
 * Run: npx tsx scripts/generate-competitive-comparison.ts
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

const TEAL = { r: 20, g: 184, b: 166 };
const DARK = { r: 15, g: 23, b: 42 };
const GREEN = { r: 34, g: 197, b: 94 };
const RED = { r: 239, g: 68, b: 68 };
const AMBER = { r: 245, g: 158, b: 11 };
const GRAY = { r: 107, g: 114, b: 128 };

interface Feature { name: string; isa: string; sage: string; qbo: string; xero: string }
interface Section { title: string; features: Feature[] }

const Y = 'YES';
const N = 'NO';
const P = 'Partial';

const SECTIONS: Section[] = [
  { title: '1. Dashboard & KPIs', features: [
    { name: 'Financial dashboard',       isa: Y, sage: Y, qbo: Y,       xero: Y },
    { name: 'Custom KPI tiles / ratios', isa: Y, sage: N, qbo: N,       xero: 'Add-on' },
    { name: 'Cash flow forecast chart',  isa: Y, sage: Y, qbo: P,       xero: 'Add-on' },
    { name: 'Executive dashboard',       isa: Y, sage: N, qbo: N,       xero: 'Add-on' },
    { name: 'Configurable widgets',      isa: Y, sage: P, qbo: Y,       xero: N },
    { name: 'Multi-company dashboard',   isa: Y, sage: N, qbo: N,       xero: N },
  ]},
  { title: '2. General Ledger', features: [
    { name: 'Chart of accounts',            isa: Y, sage: Y,     qbo: Y,       xero: Y },
    { name: 'Journal entries',              isa: Y, sage: Y,     qbo: Y,       xero: Y },
    { name: 'Recurring journals',           isa: Y, sage: 'Std', qbo: Y,       xero: Y },
    { name: 'Opening balances',             isa: Y, sage: Y,     qbo: Y,       xero: Y },
    { name: 'Lock periods',                 isa: Y, sage: Y,     qbo: Y,       xero: Y },
    { name: 'Cost centres / departments',   isa: Y, sage: N,     qbo: 'Plus+', xero: P },
    { name: 'Business units',               isa: Y, sage: N,     qbo: 'Plus+', xero: N },
    { name: 'Multi-segment COA',            isa: Y, sage: N,     qbo: N,       xero: N },
    { name: 'Year-end close',               isa: Y, sage: P,     qbo: P,       xero: P },
  ]},
  { title: '3. Customers / AR', features: [
    { name: 'Invoicing',                isa: Y, sage: Y,        qbo: Y,  xero: Y },
    { name: 'Quotes / Estimates',       isa: Y, sage: Y,        qbo: Y,  xero: Y },
    { name: 'Credit notes',             isa: Y, sage: Y,        qbo: Y,  xero: Y },
    { name: 'Recurring invoices',       isa: Y, sage: 'Std',    qbo: Y,  xero: Y },
    { name: 'Customer statements',      isa: Y, sage: Y,        qbo: Y,  xero: Y },
    { name: 'AR aging (30/60/90/120)',  isa: Y, sage: Y,        qbo: Y,  xero: Y },
    { name: 'Customer portal',          isa: Y, sage: Y,        qbo: P,  xero: '3rd party' },
    { name: 'Online payments (PayFast)',isa: Y, sage: P,        qbo: N,  xero: Y },
    { name: 'Automated reminders',      isa: Y, sage: 'Add-on', qbo: Y,  xero: Y },
    { name: 'Sales orders',             isa: Y, sage: N,        qbo: N,  xero: N },
    { name: 'Invoice approval workflow',isa: Y, sage: N,        qbo: N,  xero: '3rd party' },
    { name: 'Smart collections (AI)',   isa: Y, sage: N,        qbo: P,  xero: N },
    { name: 'Write-offs',               isa: Y, sage: P,        qbo: P,  xero: Y },
  ]},
  { title: '4. Suppliers / AP', features: [
    { name: 'Supplier invoices',              isa: Y, sage: Y, qbo: 'Ess+',  xero: Y },
    { name: 'Purchase orders',                isa: Y, sage: N, qbo: 'Plus+', xero: Y },
    { name: 'Three-way matching (PO/GRN/Inv)',isa: Y, sage: N, qbo: N,       xero: N },
    { name: 'Goods received notes',           isa: Y, sage: N, qbo: N,       xero: N },
    { name: 'AP aging',                       isa: Y, sage: Y, qbo: 'Ess+',  xero: Y },
    { name: 'Batch / EFT payments',           isa: Y, sage: P, qbo: 'Adv',   xero: Y },
    { name: 'EFT file generation (SA banks)', isa: Y, sage: P, qbo: N,       xero: '3rd party' },
    { name: 'Bill approval workflow',         isa: Y, sage: N, qbo: N,       xero: P },
    { name: 'DRC VAT',                        isa: Y, sage: N, qbo: N,       xero: P },
  ]},
  { title: '5. Banking & Reconciliation', features: [
    { name: 'Bank feeds (SA banks)',       isa: Y, sage: Y, qbo: Y, xero: Y },
    { name: 'CSV / OFX import',            isa: Y, sage: Y, qbo: Y, xero: Y },
    { name: 'PDF statement import',        isa: Y, sage: N, qbo: N, xero: N },
    { name: 'Bank rules',                  isa: Y, sage: Y, qbo: Y, xero: Y },
    { name: 'AI categorisation',           isa: Y, sage: N, qbo: Y, xero: Y },
    { name: 'Smart matching',              isa: Y, sage: P, qbo: Y, xero: Y },
    { name: 'Bank transfers',              isa: Y, sage: Y, qbo: Y, xero: Y },
    { name: 'Reconciliation reports',      isa: Y, sage: Y, qbo: Y, xero: Y },
    { name: 'Batch reconciliation',        isa: Y, sage: P, qbo: P, xero: Y },
    { name: 'VLM bank statement parsing',  isa: Y, sage: N, qbo: N, xero: N },
  ]},
  { title: '6. Reporting', features: [
    { name: 'Income statement',                 isa: Y, sage: Y,     qbo: Y,       xero: Y },
    { name: 'Balance sheet',                     isa: Y, sage: Y,     qbo: Y,       xero: Y },
    { name: 'Trial balance',                     isa: Y, sage: Y,     qbo: Y,       xero: Y },
    { name: 'Cash flow statement',               isa: Y, sage: 'Std', qbo: Y,       xero: Y },
    { name: 'Financial ratios',                  isa: Y, sage: N,     qbo: N,       xero: 'Add-on' },
    { name: 'KPI scorecard',                     isa: Y, sage: N,     qbo: N,       xero: 'Add-on' },
    { name: 'Executive summary',                 isa: Y, sage: N,     qbo: N,       xero: 'Add-on' },
    { name: 'Management report packs',           isa: Y, sage: N,     qbo: N,       xero: P },
    { name: 'Board report packs',                isa: Y, sage: N,     qbo: N,       xero: '3rd party' },
    { name: 'Three-way forecast (P&L+BS+CF)',    isa: Y, sage: N,     qbo: N,       xero: N },
    { name: 'Trend analysis',                    isa: Y, sage: N,     qbo: P,       xero: P },
    { name: 'Waterfall charts',                  isa: Y, sage: N,     qbo: N,       xero: N },
    { name: 'Budget vs actual',                  isa: Y, sage: 'Std', qbo: 'Plus+', xero: Y },
    { name: 'Custom report builder',             isa: Y, sage: N,     qbo: 'Adv',   xero: P },
    { name: 'Report pack PDF export',            isa: Y, sage: N,     qbo: N,       xero: P },
    { name: 'CaseWare export',                   isa: Y, sage: Y,     qbo: Y,       xero: N },
    { name: 'Consolidated reports',              isa: Y, sage: N,     qbo: N,       xero: N },
    { name: 'IFRS disclosure notes',             isa: Y, sage: N,     qbo: N,       xero: N },
  ]},
  { title: '7. VAT & Tax Compliance', features: [
    { name: 'VAT tracking (15%)',       isa: Y, sage: Y,         qbo: Y, xero: Y },
    { name: 'VAT201 preparation',       isa: Y, sage: 'Std',     qbo: P, xero: Y },
    { name: 'SARS eFiling integration', isa: Y, sage: Y,         qbo: N, xero: Y },
    { name: 'EMP201 submission',        isa: Y, sage: 'Payroll', qbo: N, xero: '3rd party' },
    { name: 'EMP501 reconciliation',    isa: Y, sage: 'Payroll', qbo: N, xero: '3rd party' },
    { name: 'IRP5 certificates',        isa: Y, sage: 'Payroll', qbo: N, xero: '3rd party' },
    { name: 'IRP6 provisional tax',     isa: Y, sage: N,         qbo: N, xero: 'Add-on' },
    { name: 'Compliance calendar',      isa: Y, sage: N,         qbo: N, xero: 'Add-on' },
    { name: 'VAT adjustments',          isa: Y, sage: P,         qbo: P, xero: Y },
  ]},
  { title: '8. Payroll', features: [
    { name: 'Employee management',          isa: Y, sage: 'Separate', qbo: N, xero: N },
    { name: 'Pay runs',                     isa: Y, sage: 'Separate', qbo: N, xero: N },
    { name: 'Payslips (PDF)',               isa: Y, sage: 'Separate', qbo: N, xero: N },
    { name: 'IRP5 certificates',            isa: Y, sage: 'Separate', qbo: N, xero: N },
    { name: 'Leave management (BCEA)',      isa: Y, sage: 'Separate', qbo: N, xero: N },
    { name: 'Overtime calculation (BCEA)',  isa: Y, sage: 'Separate', qbo: N, xero: N },
    { name: 'Integrated with accounting',   isa: Y, sage: P,          qbo: P, xero: P },
  ]},
  { title: '9. Fixed Assets', features: [
    { name: 'Asset register',               isa: Y, sage: N, qbo: 'Adv',     xero: Y },
    { name: 'Depreciation (SL / RB / SYD)', isa: Y, sage: N, qbo: 'SL only', xero: 'SL+RB' },
    { name: 'SARS wear-and-tear rates',     isa: Y, sage: N, qbo: N,         xero: N },
    { name: 'Asset disposal',               isa: Y, sage: N, qbo: P,         xero: Y },
    { name: 'Asset categories',             isa: Y, sage: N, qbo: 'Adv',     xero: Y },
    { name: 'Depreciation schedule report', isa: Y, sage: N, qbo: 'Adv',     xero: Y },
    { name: 'Auto-post depreciation',       isa: Y, sage: N, qbo: 'Adv',     xero: Y },
  ]},
  { title: '10. Inventory', features: [
    { name: 'Product / item management', isa: Y, sage: 'Std',    qbo: Y,       xero: Y },
    { name: 'Stock level tracking',      isa: Y, sage: 'Std',    qbo: 'Plus+', xero: P },
    { name: 'Weighted average costing',  isa: Y, sage: Y,        qbo: N,       xero: Y },
    { name: 'FIFO valuation',            isa: Y, sage: N,        qbo: Y,       xero: 'Add-on' },
    { name: 'Stock adjustments',         isa: Y, sage: Y,        qbo: 'Plus+', xero: Y },
    { name: 'Price lists (multiple)',    isa: Y, sage: 'Std',    qbo: N,       xero: N },
    { name: 'Reorder alerts',            isa: Y, sage: 'Add-on', qbo: 'Plus+', xero: N },
  ]},
  { title: '11. Projects & Time Tracking', features: [
    { name: 'Project tracking',                isa: Y, sage: 'Add-on', qbo: 'Plus+', xero: 'Add-on' },
    { name: 'Time entries',                    isa: Y, sage: 'Add-on', qbo: 'Ess+',  xero: 'Add-on' },
    { name: 'Project profitability',           isa: Y, sage: P,        qbo: 'Plus+', xero: 'Add-on' },
    { name: 'WIP tracking',                    isa: Y, sage: N,        qbo: 'Adv',   xero: N },
    { name: 'Billable time to invoice',        isa: Y, sage: 'Add-on', qbo: 'Ess+',  xero: 'Add-on' },
    { name: 'Recurring invoices from projects',isa: Y, sage: N,        qbo: N,       xero: N },
  ]},
  { title: '12. AI & Automation', features: [
    { name: 'AI transaction categorisation', isa: Y, sage: N, qbo: Y, xero: Y },
    { name: 'AI invoice extraction (VLM)',   isa: Y, sage: N, qbo: P, xero: Y },
    { name: 'AI management commentary',      isa: Y, sage: N, qbo: N, xero: N },
    { name: 'Natural language queries',      isa: Y, sage: N, qbo: N, xero: P },
    { name: 'Anomaly detection',             isa: Y, sage: N, qbo: Y, xero: P },
    { name: 'Cash flow AI forecast',         isa: Y, sage: N, qbo: P, xero: 'Add-on' },
    { name: 'Smart collections (AI)',        isa: Y, sage: N, qbo: P, xero: N },
    { name: 'Receipt-to-journal (AI)',       isa: Y, sage: N, qbo: P, xero: Y },
    { name: 'Contract-to-recurring (AI)',    isa: Y, sage: N, qbo: N, xero: N },
    { name: 'Continuous close automation',   isa: Y, sage: N, qbo: N, xero: N },
    { name: 'Three-way doc match (AI)',      isa: Y, sage: N, qbo: N, xero: N },
    { name: 'Payslip verification (AI)',     isa: Y, sage: N, qbo: N, xero: N },
  ]},
  { title: '13. Document Management', features: [
    { name: 'File attachments',            isa: Y, sage: Y, qbo: Y, xero: Y },
    { name: 'OCR document capture',        isa: Y, sage: N, qbo: Y, xero: Y },
    { name: 'Vision Language Model (VLM)', isa: Y, sage: N, qbo: N, xero: P },
    { name: 'Multi-document upload',       isa: Y, sage: N, qbo: P, xero: Y },
    { name: 'Document validation',         isa: Y, sage: N, qbo: N, xero: P },
    { name: 'Auto-create invoice from scan',isa: Y, sage: N, qbo: P, xero: Y },
  ]},
  { title: '14. Multi-Currency', features: [
    { name: 'Foreign currency invoicing',     isa: Y, sage: 'Add-on', qbo: 'Ess+', xero: 'Prem' },
    { name: 'Foreign currency bank accounts', isa: Y, sage: 'Add-on', qbo: 'Ess+', xero: 'Prem' },
    { name: 'Auto exchange rates',            isa: Y, sage: 'Add-on', qbo: 'Ess+', xero: 'Prem' },
    { name: 'Realised FX gains/losses',       isa: Y, sage: 'Add-on', qbo: 'Ess+', xero: 'Prem' },
    { name: 'Included in base price',         isa: Y, sage: N,        qbo: N,      xero: N },
  ]},
  { title: '15. Users & Security', features: [
    { name: 'Multi-user access',       isa: Y, sage: 'Std', qbo: Y,     xero: Y },
    { name: 'Role-based permissions',  isa: Y, sage: Y,     qbo: 'Adv', xero: Y },
    { name: 'Two-factor auth (2FA)',   isa: Y, sage: Y,     qbo: Y,     xero: Y },
    { name: 'Audit trail',             isa: Y, sage: Y,     qbo: Y,     xero: Y },
    { name: 'Approval workflows',      isa: Y, sage: N,     qbo: N,     xero: '3rd party' },
    { name: 'Data archiving',          isa: Y, sage: N,     qbo: N,     xero: P },
    { name: 'POPIA compliance tools',  isa: Y, sage: P,     qbo: P,     xero: P },
  ]},
  { title: '16. SA Compliance', features: [
    { name: 'BEE scorecard / reporting',  isa: Y, sage: N, qbo: N, xero: N },
    { name: 'SARS compliance calendar',   isa: Y, sage: N, qbo: N, xero: 'Add-on' },
    { name: 'Month-end close checklist',  isa: Y, sage: N, qbo: N, xero: N },
    { name: 'Year-end close',             isa: Y, sage: P, qbo: P, xero: P },
    { name: 'Data subject rights (POPIA)',isa: Y, sage: N, qbo: N, xero: N },
  ]},
  { title: '17. Group / Multi-Entity', features: [
    { name: 'Multi-company management',  isa: Y, sage: N, qbo: N, xero: N },
    { name: 'Consolidated reporting',    isa: Y, sage: N, qbo: N, xero: N },
    { name: 'Intercompany transactions', isa: Y, sage: N, qbo: N, xero: N },
    { name: 'Group chart of accounts',   isa: Y, sage: N, qbo: N, xero: N },
    { name: 'Elimination entries',        isa: Y, sage: N, qbo: N, xero: N },
  ]},
  { title: '18. Integration & Export', features: [
    { name: 'SA bank feeds',                isa: Y,     sage: Y,     qbo: Y, xero: Y },
    { name: 'PayFast gateway',              isa: Y,     sage: P,     qbo: N, xero: Y },
    { name: 'CaseWare export',              isa: Y,     sage: Y,     qbo: Y, xero: N },
    { name: 'REST API',                     isa: Y,     sage: Y,     qbo: Y, xero: Y },
    { name: 'Webhooks',                     isa: Y,     sage: P,     qbo: P, xero: Y },
    { name: 'Sage data import / migration', isa: Y,     sage: 'N/A', qbo: N, xero: P },
    { name: 'CSV / PDF / Excel export',     isa: Y,     sage: Y,     qbo: P, xero: Y },
    { name: 'Customer portal',              isa: Y,     sage: Y,     qbo: P, xero: '3rd party' },
    { name: 'Mobile app',                   isa: 'PWA', sage: Y,     qbo: Y, xero: Y },
  ]},
];

function score(v: string): number {
  if (v === Y) return 1;
  if (v === N) return 0;
  return 0.5;
}

function cellColor(v: string): [number, number, number] {
  if (v === Y) return [GREEN.r, GREEN.g, GREEN.b];
  if (v === N) return [RED.r, RED.g, RED.b];
  return [AMBER.r, AMBER.g, AMBER.b];
}

async function loadImage(relPath: string): Promise<string> {
  const fs = await import('fs');
  const path = await import('path');
  const abs = path.resolve(__dirname, '..', relPath);
  const buf = fs.readFileSync(abs);
  return 'data:image/png;base64,' + buf.toString('base64');
}

async function main() {
  const [{ jsPDF }, { default: autoTable }] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
  ]);

  const [logoReversed, logoPrimary, logoWatermark, iconSquare] = await Promise.all([
    loadImage('public/BI/logo-reversed.png'),
    loadImage('public/BI/logo-primary-transparent.png'),
    loadImage('public/BI/logo-watermark-transparent.png'),
    loadImage('public/BI/icon-square-transparent.png'),
  ]);

  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 14;

  // ── Cover Page ──────────────────────────────────────────────────────────────
  doc.setFillColor(TEAL.r, TEAL.g, TEAL.b);
  doc.rect(0, 0, W, 55, 'F');
  doc.addImage(logoReversed, 'PNG', M, 10, 65, 32);
  doc.setFontSize(10); doc.setFont('helvetica', 'normal'); doc.setTextColor(255, 255, 255);
  doc.text('Cloud Accounting for South African Businesses', M, 50);

  doc.setFontSize(24); doc.setFont('helvetica', 'bold'); doc.setTextColor(DARK.r, DARK.g, DARK.b);
  doc.text('Competitive Feature', M, 82);
  doc.text('Comparison', M, 94);
  doc.setDrawColor(TEAL.r, TEAL.g, TEAL.b); doc.setLineWidth(1);
  doc.line(M, 100, M + 50, 100);

  doc.setFontSize(12); doc.setFont('helvetica', 'normal'); doc.setTextColor(GRAY.r, GRAY.g, GRAY.b);
  doc.text('ISAFlow  vs  Sage  vs  QuickBooks  vs  Xero', M, 115);
  doc.setFontSize(11);
  doc.text('South Africa Edition  \u2014  April 2026', M, 126);

  // 4 competitor boxes
  const boxY = 150; const boxW = (W - M * 2 - 18) / 4; const boxH = 32;
  const competitors = [
    { name: 'ISAFlow',     sub: 'Cloud Accounting', sub2: 'app.isaflow.co.za', color: TEAL },
    { name: 'Sage',        sub: 'Business Cloud',   sub2: 'From R240/mo',      color: { r: 0, g: 136, b: 62 } },
    { name: 'QuickBooks',  sub: 'Online',            sub2: 'From R250/mo',      color: { r: 44, g: 160, b: 28 } },
    { name: 'Xero',        sub: 'Accounting',        sub2: 'From R299/mo',      color: { r: 19, g: 107, b: 185 } },
  ];
  competitors.forEach((c, i) => {
    const x = M + i * (boxW + 6);
    doc.setFillColor(c.color.r, c.color.g, c.color.b);
    doc.roundedRect(x, boxY, boxW, boxH, 3, 3, 'F');
    doc.setFontSize(11); doc.setFont('helvetica', 'bold'); doc.setTextColor(255, 255, 255);
    doc.text(c.name, x + boxW / 2, boxY + 12, { align: 'center' });
    doc.setFontSize(7); doc.setFont('helvetica', 'normal');
    doc.text(c.sub, x + boxW / 2, boxY + 19, { align: 'center' });
    doc.text(c.sub2, x + boxW / 2, boxY + 25, { align: 'center' });
  });

  doc.setFontSize(8); doc.setTextColor(150, 150, 150);
  doc.text('Confidential \u2014 For Internal Use', W / 2, H - 15, { align: 'center' });

  // ── Executive Summary Page ──────────────────────────────────────────────────
  doc.addPage();
  doc.setFillColor(TEAL.r, TEAL.g, TEAL.b); doc.rect(0, 0, W, 8, 'F');
  doc.addImage(logoPrimary, 'PNG', W - M - 40, 12, 40, 12);

  let y = 20;
  doc.setFontSize(18); doc.setFont('helvetica', 'bold'); doc.setTextColor(DARK.r, DARK.g, DARK.b);
  doc.text('Executive Summary', M, y + 8); y += 18;

  doc.setFontSize(9); doc.setFont('helvetica', 'normal'); doc.setTextColor(60, 60, 60);
  const summaryText = [
    'This document provides a feature-by-feature comparison of ISAFlow against the three leading',
    'cloud accounting platforms in South Africa: Sage Business Cloud, QuickBooks Online, and Xero.',
    '',
    'ISAFlow is purpose-built for South African businesses, with integrated payroll, SARS compliance,',
    'BEE reporting, fixed asset management, and advanced AI capabilities \u2014 all included in the base',
    'price. Key differentiators include multi-entity consolidation, three-way procurement matching,',
    'AI-powered document capture with Vision Language Models, and a comprehensive reporting suite.',
  ];
  summaryText.forEach((line, i) => { doc.text(line, M, y + i * 5); });
  y += summaryText.length * 5 + 6;

  // Legend
  doc.setFillColor(240, 253, 250); doc.roundedRect(M, y, W - M * 2, 18, 2, 2, 'F');
  doc.setFontSize(8); doc.setFont('helvetica', 'bold'); doc.setTextColor(TEAL.r, TEAL.g, TEAL.b);
  doc.text('Legend:', M + 4, y + 6); doc.setFont('helvetica', 'normal');
  doc.setTextColor(GREEN.r, GREEN.g, GREEN.b); doc.text('YES = Included', M + 22, y + 6);
  doc.setTextColor(AMBER.r, AMBER.g, AMBER.b); doc.text('Partial / Add-on / Tier-locked', M + 55, y + 6);
  doc.setTextColor(RED.r, RED.g, RED.b); doc.text('NO = Not available', M + 115, y + 6);
  doc.setTextColor(GRAY.r, GRAY.g, GRAY.b);
  doc.text('Std = Standard | Ess+ = Essentials+ | Plus+ = Plus | Adv = Advanced | Prem = Premium | Add-on = Paid extra | 3rd party = Via integration', M + 4, y + 13);
  y += 24;

  doc.setFontSize(12); doc.setFont('helvetica', 'bold'); doc.setTextColor(DARK.r, DARK.g, DARK.b);
  doc.text('Feature Score Summary by Module', M, y + 2); y += 6;

  const summaryRows: string[][] = [];
  let tIsa = 0, tSage = 0, tQbo = 0, tXero = 0;

  for (const s of SECTIONS) {
    let sI = 0, sS = 0, sQ = 0, sX = 0;
    for (const f of s.features) { sI += score(f.isa); sS += score(f.sage); sQ += score(f.qbo); sX += score(f.xero); }
    tIsa += sI; tSage += sS; tQbo += sQ; tXero += sX;
    const n = s.features.length;
    const fmt = (v: number) => v % 1 === 0 ? String(v) : v.toFixed(1);
    summaryRows.push([s.title, `${fmt(sI)}/${n}`, `${fmt(sS)}/${n}`, `${fmt(sQ)}/${n}`, `${fmt(sX)}/${n}`]);
  }
  const totalF = SECTIONS.reduce((s, sec) => s + sec.features.length, 0);
  const fmtT = (v: number) => v % 1 === 0 ? String(v) : v.toFixed(1);
  summaryRows.push(['TOTAL', `${fmtT(tIsa)}/${totalF}`, `${fmtT(tSage)}/${totalF}`, `${fmtT(tQbo)}/${totalF}`, `${fmtT(tXero)}/${totalF}`]);

  autoTable(doc, {
    head: [['Module', 'ISAFlow', 'Sage', 'QuickBooks', 'Xero']],
    body: summaryRows, startY: y, margin: { left: M, right: M },
    styles: { fontSize: 7, cellPadding: 1.8 },
    headStyles: { fillColor: [TEAL.r, TEAL.g, TEAL.b], textColor: [255, 255, 255], fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [249, 250, 251] },
    columnStyles: { 0: { fontStyle: 'bold' }, 1: { halign: 'center' }, 2: { halign: 'center' }, 3: { halign: 'center' }, 4: { halign: 'center' } },
    didParseCell: (data: any) => {
      if (data.row.index === summaryRows.length - 1) {
        data.cell.styles.fontStyle = 'bold';
        data.cell.styles.fillColor = [240, 253, 250];
        data.cell.styles.textColor = [TEAL.r, TEAL.g, TEAL.b];
      }
    },
  });

  // ── Feature Comparison Pages ────────────────────────────────────────────────
  for (const section of SECTIONS) {
    const prevY: number = (doc as any).lastAutoTable?.finalY ?? 20;
    if (prevY > H - 55) { doc.addPage(); (doc as any).lastAutoTable = { finalY: 15 }; }
    const startY: number = ((doc as any).lastAutoTable?.finalY ?? 15) + 10;

    doc.setFillColor(TEAL.r, TEAL.g, TEAL.b);
    doc.rect(M, startY, W - M * 2, 7, 'F');
    doc.setFontSize(8); doc.setFont('helvetica', 'bold'); doc.setTextColor(255, 255, 255);
    doc.text(section.title.toUpperCase(), M + 3, startY + 5);

    autoTable(doc, {
      head: [['Feature', 'ISAFlow', 'Sage', 'QuickBooks', 'Xero']],
      body: section.features.map(f => [f.name, f.isa, f.sage, f.qbo, f.xero]),
      startY: startY + 9, margin: { left: M, right: M },
      styles: { fontSize: 7, cellPadding: 1.8 },
      headStyles: { fillColor: [240, 253, 250], textColor: [TEAL.r, TEAL.g, TEAL.b], fontStyle: 'bold' },
      alternateRowStyles: { fillColor: [249, 250, 251] },
      columnStyles: { 1: { halign: 'center' }, 2: { halign: 'center' }, 3: { halign: 'center' }, 4: { halign: 'center' } },
      didParseCell: (data: any) => {
        if (data.section === 'body' && data.column.index >= 1) {
          const [r, g, b] = cellColor(data.cell.raw as string);
          data.cell.styles.textColor = [r, g, b];
          data.cell.styles.fontStyle = 'bold';
        }
      },
    });
  }

  // ── Score Summary Page ──────────────────────────────────────────────────────
  doc.addPage();
  doc.setFillColor(TEAL.r, TEAL.g, TEAL.b); doc.rect(0, 0, W, 8, 'F');
  doc.addImage(logoPrimary, 'PNG', W - M - 40, 12, 40, 12);

  doc.setFontSize(18); doc.setFont('helvetica', 'bold'); doc.setTextColor(DARK.r, DARK.g, DARK.b);
  doc.text('Overall Score', M, 28);
  doc.setFontSize(10); doc.setFont('helvetica', 'normal'); doc.setTextColor(GRAY.r, GRAY.g, GRAY.b);
  doc.text(`${totalF} features compared across 18 modules`, M, 36);

  const cardY = 48; const cardW = (W - M * 2 - 18) / 4; const cardH = 50;
  const scores = [
    { name: 'ISAFlow',    s: tIsa,  color: TEAL },
    { name: 'Sage',       s: tSage, color: { r: 0, g: 136, b: 62 } },
    { name: 'QuickBooks', s: tQbo,  color: { r: 44, g: 160, b: 28 } },
    { name: 'Xero',       s: tXero, color: { r: 19, g: 107, b: 185 } },
  ];
  scores.forEach((sc, i) => {
    const x = M + i * (cardW + 6);
    doc.setFillColor(sc.color.r, sc.color.g, sc.color.b);
    doc.roundedRect(x, cardY, cardW, cardH, 3, 3, 'F');
    doc.setFontSize(11); doc.setFont('helvetica', 'bold'); doc.setTextColor(255, 255, 255);
    doc.text(sc.name, x + cardW / 2, cardY + 12, { align: 'center' });
    doc.setFontSize(24);
    doc.text(`${Math.round((sc.s / totalF) * 100)}%`, x + cardW / 2, cardY + 30, { align: 'center' });
    doc.setFontSize(8); doc.setFont('helvetica', 'normal');
    doc.text(`${fmtT(sc.s)} / ${totalF}`, x + cardW / 2, cardY + 40, { align: 'center' });
  });

  const tkY = cardY + cardH + 15;
  doc.setFontSize(12); doc.setFont('helvetica', 'bold'); doc.setTextColor(DARK.r, DARK.g, DARK.b);
  doc.text('Key Takeaways', M, tkY);

  const takeaways = [
    'ISAFlow offers the most comprehensive feature set of any SA cloud accounting platform.',
    'No competitor offers integrated SA payroll \u2014 all require separate paid subscriptions.',
    'ISAFlow is the only platform with AI management commentary and three-way forecasting.',
    'Sage has no fixed assets, no purchase orders, and no AI features.',
    'QuickBooks locks critical features (assets, POs, budgets, custom roles) behind expensive tiers.',
    'Xero has strong banking/OCR but no group reporting, no BEE, no native SA payroll.',
    'ISAFlow is the only platform with BEE reporting, SARS compliance calendar, and POPIA tools.',
    'Multi-currency is included in ISAFlow; it costs extra on Sage, QBO, and Xero.',
    'ISAFlow includes everything in the base price \u2014 no add-on fees.',
  ];
  doc.setFontSize(8); doc.setFont('helvetica', 'normal');
  takeaways.forEach((t, i) => {
    doc.setTextColor(TEAL.r, TEAL.g, TEAL.b); doc.text('\u2022', M + 2, tkY + 8 + i * 5.5);
    doc.setTextColor(60, 60, 60); doc.text(t, M + 7, tkY + 8 + i * 5.5);
  });

  // ── Back Cover ──────────────────────────────────────────────────────────────
  doc.addPage();
  doc.setFillColor(DARK.r, DARK.g, DARK.b); doc.rect(0, 0, W, H, 'F');
  doc.addImage(iconSquare, 'PNG', W / 2 - 15, 75, 30, 30);
  doc.setFontSize(22); doc.setFont('helvetica', 'bold'); doc.setTextColor(255, 255, 255);
  doc.text('ISAFlow', W / 2, 120, { align: 'center' });
  doc.setFontSize(12); doc.setFont('helvetica', 'normal'); doc.setTextColor(200, 200, 200);
  doc.text('Built for South African businesses', W / 2, 135, { align: 'center' });
  doc.setFontSize(10); doc.setTextColor(TEAL.r, TEAL.g, TEAL.b);
  doc.text('app.isaflow.co.za', W / 2, 150, { align: 'center' });
  doc.setFontSize(8); doc.setTextColor(100, 100, 100);
  doc.text('\u00A9 2026 ISAFlow. All rights reserved.', W / 2, H - 20, { align: 'center' });

  // ── Page footers (watermark + page numbers) ─────────────────────────────────
  const pageCount = doc.getNumberOfPages();
  for (let i = 2; i < pageCount; i++) {
    doc.setPage(i);
    // Watermark — bottom-right, subtle
    doc.saveGraphicsState();
    (doc as any).setGState(new (doc as any).GState({ opacity: 0.06 }));
    doc.addImage(logoWatermark, 'PNG', W - M - 70, H - 45, 65, 20);
    doc.restoreGraphicsState();
    // Footer line
    doc.setDrawColor(TEAL.r, TEAL.g, TEAL.b); doc.setLineWidth(0.3);
    doc.line(M, H - 12, W - M, H - 12);
    doc.setFontSize(7); doc.setFont('helvetica', 'normal'); doc.setTextColor(150, 150, 150);
    doc.text('ISAFlow \u2014 Competitive Feature Comparison', M, H - 8);
    doc.text(`Page ${i - 1} of ${pageCount - 2}`, W - M, H - 8, { align: 'right' });
  }

  // ── Save ────────────────────────────────────────────────────────────────────
  const buffer = Buffer.from(doc.output('arraybuffer'));
  const fs = await import('fs');
  const path = await import('path');
  const outPath = path.resolve(__dirname, '..', 'docs', 'ISAFlow-Competitive-Comparison-2026.pdf');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, buffer);
  const sizeMB = (buffer.byteLength / 1024 / 1024).toFixed(2);
  console.log(`PDF generated: ${outPath} (${sizeMB} MB, ${pageCount} pages)`);
}

main().catch(err => { console.error('Failed:', err); process.exit(1); });
