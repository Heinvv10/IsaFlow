/**
 * Pure: where a proof of payment's PDF is copied in SharePoint (migration 992).
 *   <folder>/YYYY/MM/YYYY-MM-DD <Beneficiary> R<amount> <transaction number>.pdf
 * e.g. "Proof of Payments/2026/11/2026-11-13 Amoepong Bed and Bre R3000.00 80AB12CD34-11.pdf".
 * The transaction number is ABSA's own and unique per payment, so the same name is the same payment.
 */

export interface ArchivablePop {
  paymentDate: string; // YYYY-MM-DD
  beneficiary: string;
  amount: string; // NUMERIC(14,2) as Postgres prints it, e.g. "3000.00"
  transactionNumber: string;
}

/** SharePoint refuses `" * : < > ? / \ |` and control characters; leading/trailing spaces and dots too. */
export function sanitizeSharePointName(name: string): string {
  return name
    .replace(/["*:<>?/\\|\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[ .]+|[ .]+$/g, '');
}

/** The folder setting, each segment sanitised and empty ones dropped ("/A//B/" → "A/B"). */
export function sanitizeFolderPath(folder: string): string {
  return folder.split('/').map(sanitizeSharePointName).filter((s) => s !== '').join('/');
}

export function popArchivePath(folder: string, pop: ArchivablePop): string {
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(pop.paymentDate);
  if (!m) throw new Error(`popArchivePath: payment date is not YYYY-MM-DD: ${pop.paymentDate}`);
  if (!/^\d+\.\d{2}$/.test(pop.amount)) throw new Error(`popArchivePath: amount is not 0.00-shaped: ${pop.amount}`);
  const file = sanitizeSharePointName(
    `${pop.paymentDate} ${pop.beneficiary} R${pop.amount} ${pop.transactionNumber}`);
  const base = sanitizeFolderPath(folder);
  return `${base ? `${base}/` : ''}${m[1]}/${m[2]}/${file}.pdf`;
}

/** The path as Graph's `root:/{path}:` addressing wants it: each segment URL-encoded, slashes kept. */
export function encodeDrivePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}
