/**
 * EFT File Generation Service — South African Bank Formats
 * Generates payment files for: Standard Bank, FNB, ABSA, Nedbank, Capitec
 * Pure business logic — no database dependencies.
 */

export interface EFTPayment {
  beneficiaryName: string;
  beneficiaryAccountNumber: string;
  beneficiaryBranchCode: string;
  beneficiaryAccountType: 'current' | 'savings' | 'transmission';
  amount: number;
  reference: string;
  beneficiaryBank?: string;
}

export interface EFTBatchHeader {
  companyName: string;
  bankAccountNumber: string;
  branchCode: string;
  accountType: 'current' | 'savings';
  batchReference: string;
  actionDate: string; // YYYY-MM-DD
}

export interface EFTValidationResult {
  valid: boolean;
  errors: string[];
  totalAmount: number;
  paymentCount: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// FORMATTING UTILITIES
// ═══════════════════════════════════════════════════════════════════════════

export function formatEFTAmount(amount: number): string {
  return String(Math.round(amount * 100));
}

export function padRight(str: string, length: number): string {
  return str.substring(0, length).padEnd(length, ' ');
}

export function padLeft(str: string, length: number): string {
  const s = String(str);
  return s.length > length ? s.substring(s.length - length) : s.padStart(length, '0');
}

function formatDate(dateStr: string): string {
  return dateStr.replace(/-/g, '').substring(2); // YYMMDD
}

function accountTypeCode(type: string): string {
  switch (type) {
    case 'current': return '1';
    case 'savings': return '2';
    case 'transmission': return '3';
    default: return '1';
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// VALIDATION
// ═════════════════════���═════════════════════════════════════════════════════

export function validateBankAccount(accountNumber: string, branchCode: string): { valid: boolean; error?: string } {
  if (!accountNumber || accountNumber.trim() === '') return { valid: false, error: 'Account number is required' };
  if (!branchCode || branchCode.trim() === '') return { valid: false, error: 'Branch code is required' };
  if (!/^\d+$/.test(accountNumber)) return { valid: false, error: 'Account number must contain only digits' };
  if (!/^\d{6}$/.test(branchCode)) return { valid: false, error: 'Branch code must be exactly 6 digits' };
  return { valid: true };
}

export function validateEFTBatch(header: EFTBatchHeader, payments: EFTPayment[]): EFTValidationResult {
  const errors: string[] = [];

  if (!payments || payments.length === 0) {
    errors.push('At least one payment is required');
    return { valid: false, errors, totalAmount: 0, paymentCount: 0 };
  }

  let totalAmount = 0;
  for (let i = 0; i < payments.length; i++) {
    const p = payments[i]!;
    if (!p.beneficiaryName || p.beneficiaryName.trim() === '') errors.push(`Payment ${i + 1}: Beneficiary name is required`);
    if (!p.beneficiaryAccountNumber || p.beneficiaryAccountNumber.trim() === '') errors.push(`Payment ${i + 1}: Account number is required`);
    if (!p.amount || p.amount <= 0) errors.push(`Payment ${i + 1}: Amount must be greater than zero`);
    totalAmount += p.amount || 0;
  }

  totalAmount = Math.round(totalAmount * 100) / 100;
  return { valid: errors.length === 0, errors, totalAmount, paymentCount: payments.length };
}

// ═════════════════════════════════════════════════════���═════════════════════
// STANDARD BANK ACB FORMAT
// ══════��═══════════════════════════════════════════════════════��════════════

export function generateStandardBankACB(header: EFTBatchHeader, payments: EFTPayment[]): string {
  const lines: string[] = [];
  const date = formatDate(header.actionDate);
  const totalCents = payments.reduce((s, p) => s + Math.round(p.amount * 100), 0);

  // Header record
  lines.push(
    'H' +
    padLeft(header.branchCode, 6) +
    padLeft(header.bankAccountNumber, 11) +
    padRight(header.companyName, 30) +
    date +
    padRight(header.batchReference, 20) +
    padLeft(String(payments.length), 6)
  );

  // Transaction records
  for (const p of payments) {
    lines.push(
      'T' +
      padLeft(p.beneficiaryBranchCode, 6) +
      padLeft(p.beneficiaryAccountNumber, 11) +
      accountTypeCode(p.beneficiaryAccountType) +
      padLeft(formatEFTAmount(p.amount), 11) +
      padRight(p.beneficiaryName, 30) +
      padRight(p.reference, 20)
    );
  }

  // Trailer record
  lines.push(
    'Z' +
    padLeft(String(payments.length), 6) +
    padLeft(String(totalCents), 12) +
    padRight('', 62)
  );

  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════
// FNB EFT FORMAT
// ═══════════════════════════════════════════════════════════���═══════════════

export function generateFNBEFT(header: EFTBatchHeader, payments: EFTPayment[]): string {
  const lines: string[] = [];
  const date = formatDate(header.actionDate);
  const totalCents = payments.reduce((s, p) => s + Math.round(p.amount * 100), 0);

  // Header
  lines.push(
    'EFT' +
    padLeft(header.branchCode, 6) +
    padLeft(header.bankAccountNumber, 11) +
    date +
    padRight(header.companyName, 30) +
    padRight(header.batchReference, 12)
  );

  // Transactions
  for (const p of payments) {
    lines.push(
      'STD' +
      padLeft(p.beneficiaryBranchCode, 6) +
      padLeft(p.beneficiaryAccountNumber, 11) +
      accountTypeCode(p.beneficiaryAccountType) +
      padLeft(formatEFTAmount(p.amount), 11) +
      padRight(p.beneficiaryName, 30) +
      padRight(p.reference, 12)
    );
  }

  // Trailer
  lines.push(
    'END' +
    padLeft(String(payments.length), 6) +
    padLeft(String(totalCents), 12) +
    padRight('', 50)
  );

  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════
// ABSA EFT FORMAT
// ════════════════════════��════════════════════════════��═════════════════════

export function generateABSAEFT(header: EFTBatchHeader, payments: EFTPayment[]): string {
  const lines: string[] = [];
  const date = formatDate(header.actionDate);
  const totalCents = payments.reduce((s, p) => s + Math.round(p.amount * 100), 0);

  lines.push(
    '04' + date +
    padLeft(header.branchCode, 6) +
    padLeft(header.bankAccountNumber, 11) +
    padRight(header.companyName, 30) +
    padRight(header.batchReference, 12)
  );

  for (const p of payments) {
    lines.push(
      '50' +
      padLeft(p.beneficiaryBranchCode, 6) +
      padLeft(p.beneficiaryAccountNumber, 11) +
      accountTypeCode(p.beneficiaryAccountType) +
      padLeft(formatEFTAmount(p.amount), 11) +
      padRight(p.beneficiaryName, 30) +
      padRight(p.reference, 12)
    );
  }

  lines.push(
    '92' +
    padLeft(String(payments.length), 6) +
    padLeft(String(totalCents), 12) +
    padRight('', 50)
  );

  return lines.join('\n');
}

// ═══════════════════════════════���═══════════════════════════════════════════
// NEDBANK EFT FORMAT
// ══��═══════════════════════════════════════════════════════════════���════════

export function generateNedbankEFT(header: EFTBatchHeader, payments: EFTPayment[]): string {
  const lines: string[] = [];
  const date = formatDate(header.actionDate);
  const totalCents = payments.reduce((s, p) => s + Math.round(p.amount * 100), 0);

  lines.push(
    'HDR' +
    date +
    padLeft(header.branchCode, 6) +
    padLeft(header.bankAccountNumber, 11) +
    padRight(header.companyName, 30) +
    padRight(header.batchReference, 12)
  );

  for (const p of payments) {
    lines.push(
      'TXN' +
      padLeft(p.beneficiaryBranchCode, 6) +
      padLeft(p.beneficiaryAccountNumber, 11) +
      accountTypeCode(p.beneficiaryAccountType) +
      padLeft(formatEFTAmount(p.amount), 11) +
      padRight(p.beneficiaryName, 30) +
      padRight(p.reference, 12)
    );
  }

  lines.push(
    'TRL' +
    padLeft(String(payments.length), 6) +
    padLeft(String(totalCents), 12) +
    padRight('', 50)
  );

  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════��═══════════════
// CAPITEC EFT FORMAT
// ═══════════════════��════════════════════════════════════���══════════════════

export function generateCapitecEFT(header: EFTBatchHeader, payments: EFTPayment[]): string {
  const lines: string[] = [];
  const date = formatDate(header.actionDate);
  const totalCents = payments.reduce((s, p) => s + Math.round(p.amount * 100), 0);

  lines.push(
    'H,' + date + ',' +
    header.branchCode + ',' +
    header.bankAccountNumber + ',' +
    header.companyName + ',' +
    header.batchReference
  );

  for (const p of payments) {
    lines.push(
      'T,' +
      p.beneficiaryBranchCode + ',' +
      p.beneficiaryAccountNumber + ',' +
      accountTypeCode(p.beneficiaryAccountType) + ',' +
      formatEFTAmount(p.amount) + ',' +
      p.beneficiaryName + ',' +
      p.reference
    );
  }

  lines.push(
    'Z,' + payments.length + ',' + totalCents
  );

  return lines.join('\n');
}
