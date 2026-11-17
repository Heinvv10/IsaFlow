/**
 * The salary bank file: a BankservAfrica ACB payments file in the layout a bank publishes (wave 6 BF, grill F6).
 * Pure: no database, no clock. eftService's Standard Bank generator is NOT used: it writes a homegrown H/T/Z layout.
 *
 * SOURCE (the only one this file follows): First National Bank, "Payments – Bankserv (ACB) File Format", South Africa,
 * February 2023 (16 pages; public PDF at
 * https://www.online.fnb.co.za/rhelp_0_15/OBE_SA_Downloads/assets/docs/Payment_Bankserv_File_Format_SA.pdf,
 * SHA-256 985b71719b3165472809bbae97163b045700e6e342238bb3ca5339f13e95a31a, read 2026-11-16; not committed).
 * Page references below are to it.
 * It is FNB's Online Banking Enterprise import profile of the ACB standard, so the file is claimed importable at FNB
 * only; other banks' import profiles are not claimed. Nothing is paid from it until a bank has accepted a test import
 * (the platform flag payroll_salary_bank_file stays off until then; spec rule 20).
 *
 * Shape: 02 installation header, 04 user header, one 10 transaction per employee, one 12 contra (one action date,
 * one paying account: p.9 "a contra record is required for each action date and/or From Account"), 92 user trailer
 * with the hash total, 94 installation trailer. Every record is 180 characters (the field tables, pp.2-12) and ends
 * in CR LF (p.1: "The record length is 181 characters, including the Carriage Return (ASCII 13) and Line Feed
 * (ASCII 10)" — the field tables sum to 180 plus two control characters; the bank's test import settles which).
 * Numeric fields are right-aligned zero-filled; text fields left-aligned space-filled; every filler is zeros
 * ("blank spaces or zeros", each table).
 */

export const ACB_LAYOUT = 'fnb_obe_2023_02' as const;
export const ACB_RECORD_LENGTH = 180;

/** Payroll account types (payrollBankDetailsService.ACCOUNT_TYPES) to the ACB Type of Account (p.5). */
const ACCOUNT_TYPE_CODE = { cheque: '1', savings: '2', transmission: '3' } as const;
export type AcbAccountType = keyof typeof ACCOUNT_TYPE_CODE;

/** Field 9 (p.6): 11 digits of cents. */
export const ACB_MAX_AMOUNT_CENTS = 99_999_999_999;
/** p.1: at most 100 000 payments in one file. */
export const ACB_MAX_PAYMENTS = 100_000;

export interface AcbAccount {
  /** 6 digits (fields 2 / 6). */
  branchCode: string;
  /** 1 to 11 digits (fields 3 / 7); longer numbers go in field 18, which this writer never uses. */
  accountNumber: string;
}

export interface AcbPayment extends AcbAccount {
  accountType: AcbAccountType;
  amountCents: number;
  /** To Account Reference (field 14, 20 AN, p.7): printed on the recipient's statement. */
  reference: string;
  /** Homing Account Name (field 16, 15 AN, p.7): a reference only, not validated by the bank. */
  accountName: string;
}

export interface AcbFileInput {
  /** The paying (nominated) account. */
  from: AcbAccount;
  /** YYYY-MM-DD; written YYMMDD in the contra (field 5, p.10). */
  actionDate: string;
  payments: AcbPayment[];
}

export interface AcbFile {
  content: string;
  lineCount: number;
  totalCents: number;
  /** User trailer field 3 (p.11, algorithm p.14). */
  hashTotal: string;
  /** What the layout cut or replaced, one sentence each, for the caller to show. */
  warnings: string[];
}

/** Whose field failed: the paying account (and file-level facts), or payment `index` (0-based) of `payments`. */
export type AcbFieldOwner = { kind: 'from' } | { kind: 'payment'; index: number } | { kind: 'file' };

/** A caller passed something the layout cannot hold. The service maps `owner` to its own refusal (paying account / employee). */
export class AcbFileInputError extends Error {
  constructor(message: string, readonly owner: AcbFieldOwner = { kind: 'file' }) {
    super(message);
    this.name = 'AcbFileInputError';
  }
}

const zeros = (n: number): string => '0'.repeat(n);

/**
 * An account number (fields 3 / 7): 1 to 11 digits, and not all zeros. p.4 field 7: a zero-filled homing account means
 * "use the non-standard account (field 18)", which this writer leaves zero (p.8: zero-filled = unused), so all zeros
 * would name no account at all.
 */
function account(value: string, what: string, owner: AcbFieldOwner): string {
  if (!/^\d+$/.test(value) || value.length > 11) throw new AcbFileInputError(`${what} must be 1 to 11 digits`, owner);
  if (/^0+$/.test(value)) throw new AcbFileInputError(`${what} cannot be all zeros`, owner);
  return value.padStart(11, '0');
}

/**
 * A branch code is exactly 6 digits: a short one zero-padded is no branch at all. 000000 is the Public Recipient marker
 * (p.4 field 6), which needs account type 0 and field 18; a cheque, savings or transmission payment never uses it.
 */
function branch(value: string, what: string, owner: AcbFieldOwner): string {
  if (!/^\d{6}$/.test(value)) throw new AcbFileInputError(`${what} must be exactly 6 digits`, owner);
  if (value === '000000') throw new AcbFileInputError(`${what} 000000 is the public-recipient code, not a bank branch`, owner);
  return value;
}

/** Printable ASCII only: accents are folded (é -> e), anything else becomes a space. */
export function acbText(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7e]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** A text field (p.7 fields 14 and 16 "must contain" a reference / the account name): never blank once folded. */
function text(value: string, width: number, what: string, warnings: string[], owner: AcbFieldOwner): string {
  const clean = acbText(value);
  if (clean === '') throw new AcbFileInputError(`${what} "${value}" has no characters the bank file can carry`, owner);
  if (clean !== value.trim()) warnings.push(`${what} "${value}" is written as "${clean.slice(0, width)}" (the bank file takes plain characters only)`);
  else if (clean.length > width) warnings.push(`${what} "${clean}" is cut to ${width} characters in the bank file`);
  return clean.slice(0, width).padEnd(width, ' ');
}

function record(r: string): string {
  if (r.length !== ACB_RECORD_LENGTH) throw new Error(`ACB record is ${r.length} characters, not ${ACB_RECORD_LENGTH}: ${r.slice(0, 2)}`);
  return r;
}

/** Hash total (p.14): every homing account number (11 digits) plus the paying account once; the last 12 digits. */
export function acbHashTotal(from: AcbAccount, payments: readonly AcbAccount[]): string {
  const sum = payments.reduce((s, p) => s + BigInt(p.accountNumber), BigInt(from.accountNumber));
  return (sum % 1_000_000_000_000n).toString().padStart(12, '0');
}

export function buildAcbPaymentFile(input: AcbFileInput): AcbFile {
  const { from, payments } = input;
  if (payments.length === 0) throw new AcbFileInputError('A bank file needs at least one payment');
  if (payments.length > ACB_MAX_PAYMENTS) throw new AcbFileInputError(`A bank file holds at most ${ACB_MAX_PAYMENTS} payments`);
  const date = /^\d{2}(\d{2})-(\d{2})-(\d{2})$/.exec(input.actionDate);
  if (!date) throw new AcbFileInputError('Action date must be YYYY-MM-DD');
  const FROM: AcbFieldOwner = { kind: 'from' };
  const userBranch = branch(from.branchCode, 'The paying branch code', FROM);
  const userAccount = account(from.accountNumber, 'The paying account number', FROM);
  const warnings: string[] = [];
  const records: string[] = [record('02' + zeros(178)), record('04' + zeros(178))];

  let totalCents = 0n;
  payments.forEach((p, i) => {
    const n = i + 1;
    const owner: AcbFieldOwner = { kind: 'payment', index: i };
    if (!Number.isSafeInteger(p.amountCents) || p.amountCents <= 0 || p.amountCents > ACB_MAX_AMOUNT_CENTS) {
      throw new AcbFileInputError(`Payment ${n}: the amount must be 1 to ${ACB_MAX_AMOUNT_CENTS} cents`, owner);
    }
    if (!Object.hasOwn(ACCOUNT_TYPE_CODE, p.accountType)) {
      throw new AcbFileInputError(`Payment ${n}: unknown account type '${String(p.accountType)}'`, owner);
    }
    const type = ACCOUNT_TYPE_CODE[p.accountType];
    totalCents += BigInt(p.amountCents);
    records.push(record(
      '10' // 1 Record Identifier (p.3: 10 or 20 for payments)
      + userBranch // 2 User Branch, 3-8
      + userAccount // 3 User Nominated Account, 9-19
      + zeros(4) // 4 Filler, 20-23
      + String(n).padStart(6, '0') // 5 User Sequence Number, 24-29, ascending
      + branch(p.branchCode, `Payment ${n}: the branch code`, owner) // 6 Homing Branch, 30-35 (p.4)
      + account(p.accountNumber, `Payment ${n}: the account number`, owner) // 7 Homing Account, 36-46 (p.4)
      + type // 8 Type of Account, 47 (p.5)
      + String(p.amountCents).padStart(11, '0') // 9 Amount in cents, 48-58 (p.6)
      + zeros(8) // 10 Filler, 59-66
      + '0' // 11 Tax Code, 67: "should always be zero"
      + zeros(2) + '0' // 12, 13 Fillers, 68-70
      + text(p.reference, 20, `Payment ${n} reference`, warnings, owner) // 14 To Account Reference, 71-90 (p.7)
      + zeros(10) // 15 Filler, 91-100
      + text(p.accountName, 15, `Payment ${n} account name`, warnings, owner) // 16 Homing Account Name, 101-115 (p.7)
      + zeros(15) // 17 Filler, 116-130
      + zeros(20) // 18 Non-Standard Account Number, 131-150 (p.8): zero-filled when unused
      + zeros(30), // 19 Filler, 151-180
    ));
  });

  records.push(record(
    '12' // 1 Contra for record 10 (p.9)
    + userBranch + userAccount // 2-3 the paying account, 3-19 (p.9-10)
    + zeros(39) // 4 Filler, 20-58
    + date[1] + date[2] + date[3] // 5 Action date YYMMDD, 59-64 (p.10)
    + zeros(116), // 6 Filler, 65-180
  ));
  const hashTotal = acbHashTotal(from, payments);
  records.push(record('92' + zeros(70) + hashTotal + zeros(96))); // p.11: hash total at 73-84
  records.push(record('94' + zeros(178))); // p.12

  // No total field in this layout; the caller records it. Summed exactly, and refused past a safe integer.
  if (totalCents > BigInt(Number.MAX_SAFE_INTEGER)) throw new AcbFileInputError('The file total is too large to record');
  return { content: records.map((r) => `${r}\r\n`).join(''), lineCount: payments.length, totalCents: Number(totalCents), hashTotal, warnings };
}
