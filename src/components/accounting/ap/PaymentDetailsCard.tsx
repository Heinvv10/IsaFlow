/**
 * The supplier payment page's details card: its reference and description
 * (moved here unchanged) and — R-035 PR5 round 1 LOW (c) — where the money
 * goes: the payee's bank details as they stand NOW. The approval binds them
 * (they are read live, not copied onto the payment), so the person submitting
 * or processing sees what an approver vouched for.
 */
export interface PayeeBank {
  bankName: string | null;
  accountNumber: string | null;
  branchCode: string | null;
  accountHolder: string | null;
}

export function PaymentDetailsCard({ reference, description, payeeBank }: {
  reference?: string; description?: string; payeeBank?: PayeeBank | null;
}) {
  const bank = payeeBank && [payeeBank.bankName, payeeBank.accountNumber, payeeBank.branchCode].some(Boolean)
    ? [payeeBank.bankName, payeeBank.accountNumber, payeeBank.branchCode && `branch ${payeeBank.branchCode}`,
      payeeBank.accountHolder].filter(Boolean).join(' · ')
    : null;
  if (!reference && !description && !bank) return null;
  return (
    <div className="p-4 rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
      {reference && <p className="text-sm text-[var(--ff-text-secondary)]">Reference: <span className="text-[var(--ff-text-primary)] font-mono">{reference}</span></p>}
      {description && <p className="text-sm text-[var(--ff-text-secondary)] mt-1">{description}</p>}
      {bank && <p className="text-sm text-[var(--ff-text-secondary)] mt-1">Paid into: <span className="text-[var(--ff-text-primary)] font-mono">{bank}</span></p>}
    </div>
  );
}
