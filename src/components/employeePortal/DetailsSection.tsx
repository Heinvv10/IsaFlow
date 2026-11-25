/**
 * The employee portal's "Your details" (wave 7 EA1, W5; Hein's ruling 10): the address and bank account the employer
 * holds for the signed-in employee, read-only. The bank account is its bank name and last four digits only
 * (employeePortalDetails.ts). There is no edit here: the employee asks their employer, who changes it on the record.
 */
import {
  postalLines, residentialLines, type EmployeeAddress,
} from '@/modules/accounting/services/payroll/payrollEmployeeAddressInput';
import type { PortalBankSummary } from '@/modules/accounting/services/payroll/employeePortalDetails';

const muted = 'text-sm text-gray-600 dark:text-gray-300';
const term = 'text-xs font-medium uppercase tracking-wide text-gray-600 dark:text-gray-300';

function Lines({ lines }: { lines: string[] }) {
  return <dd className="text-sm">{lines.map((l, i) => <span key={i} className="block">{l}</span>)}</dd>;
}

export function DetailsSection({ address, bank }: { address: EmployeeAddress | null; bank: PortalBankSummary | null }) {
  return (
    <section aria-labelledby="details" className="mb-8">
      <h2 id="details" className="mb-2 text-lg font-semibold">Your details</h2>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-3">
        <div>
          <dt className={term}>Residential address</dt>
          {address ? <Lines lines={residentialLines(address.residential)} /> : <dd className={muted}>Not on record</dd>}
        </div>
        <div>
          <dt className={term}>Postal address</dt>
          {address
            ? <Lines lines={address.postal.sameAsResidential ? ['Same as your residential address'] : postalLines(address)} />
            : <dd className={muted}>Not on record</dd>}
        </div>
        <div>
          <dt className={term}>Bank account</dt>
          {bank
            ? <dd className="text-sm">{bank.bankName}<span className="block">Account ending {bank.accountLast4}</span></dd>
            : <dd className={muted}>Not on record</dd>}
        </div>
      </dl>
      <p className={`mt-3 ${muted}`}>These are the details your employer holds for you. To change them, ask your employer.</p>
    </section>
  );
}
