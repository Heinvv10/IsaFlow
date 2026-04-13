/**
 * generateStatementsBatch — fetches company details + per-customer statement data,
 * generates PDFs via generateStatementPdf, and triggers a download (single PDF or ZIP).
 */

import { log } from '@/lib/logger';
import { apiFetch } from '@/lib/apiFetch';
import type { CustomerBalance } from '@/components/accounting/CustomerStatementTable';
import type { StatementData } from '@/modules/accounting/utils/statementPdf';

async function fetchCompanyMeta(): Promise<Partial<StatementData>> {
  try {
    const res = await apiFetch('/api/accounting/company-details');
    const json = await res.json();
    const c = json.data || json;
    const parts = [c.address_line1, c.city, c.province, c.postal_code].filter(Boolean);
    return {
      companyName: c.name || c.company_name || '',
      companyVatNumber: c.vat_number || c.company_vat_number || '',
      companyEmail: c.email || c.company_email || '',
      companyPhone: c.phone || c.company_phone || '',
      companyAddress: parts.join(', '),
      accentColor: c.primary_color || '#0d9488',
    };
  } catch {
    return { accentColor: '#0d9488' };
  }
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export async function generateStatementsBatch(
  selected: Set<string>,
  customers: CustomerBalance[],
  asAtDate: string
): Promise<void> {
  const { generateStatementPdf } = await import(
    '@/modules/accounting/utils/statementPdf'
  );

  const companyMeta = await fetchCompanyMeta();
  const pdfs: { name: string; blob: Blob }[] = [];

  for (const clientId of selected) {
    const cust = customers.find(c => c.client_id === clientId);
    if (!cust) continue;

    const detailRes = await apiFetch(
      `/api/accounting/customer-statement-detail?client_id=${clientId}`
    );
    const detailJson = await detailRes.json();
    const detail = detailJson.data || detailJson;

    const stmtData: StatementData = {
      ...companyMeta,
      clientName: cust.client_name,
      clientEmail: detail.client?.email || undefined,
      clientPhone: detail.client?.phone || undefined,
      asAtDate,
      totalInvoiced: detail.summary?.totalInvoiced || 0,
      totalPaid: detail.summary?.totalPaid || 0,
      totalCredits: detail.summary?.totalCredits || 0,
      balanceOutstanding: detail.summary?.balance || 0,
      transactions: detail.transactions || [],
    };

    const blob = await generateStatementPdf(stmtData);
    const safeName = cust.client_name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    pdfs.push({ name: `statement-${safeName}.pdf`, blob });
  }

  if (pdfs.length === 0) return;

  if (pdfs.length === 1 && pdfs[0]) {
    downloadBlob(pdfs[0].blob, pdfs[0].name);
    return;
  }

  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  for (const pdf of pdfs) {
    zip.file(pdf.name, pdf.blob);
  }
  const zipBlob = await zip.generateAsync({ type: 'blob' });
  downloadBlob(zipBlob, `statements-${asAtDate}.zip`);
  log.info('Statements ZIP generated', { count: pdfs.length }, 'generateStatementsBatch');
}
