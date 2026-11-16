/** A GenerateInput with stand-in account ids, for the generator's unit tests. */

import type { GenerateInput } from '../../../../scripts/lib/demoReseed/types';
import { DEMO_COMPANY_ID, FALLBACK_ACTOR_ID } from '../../../../scripts/lib/demoReseed/constants';

const acct = (n: number): string => `0a000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export const ACCOUNTS = {
  bank: acct(1110), receivable: acct(1120), payable: acct(2110), vatOutput: acct(2120), vatInput: acct(1140),
  salesRevenue: acct(4100), serviceRevenue: acct(4200), otherIncome: acct(4300), openingEquity: acct(3300),
  bankCharges: acct(5700), labour: acct(5200), paye: acct(2140), uif: acct(2150), sdl: acct(2160),
  equipment: acct(1210), vehicles: acct(1220), accumulatedDepreciation: acct(1230), depreciationExpense: acct(5800),
  expenseByCode: { '5100': acct(5100), '5400': acct(5400), '5600': acct(5600) },
};

export function inputFor(today: string, seed = 7): GenerateInput {
  return {
    today, seed, companyId: DEMO_COMPANY_ID, actorId: FALLBACK_ACTOR_ID, accounts: ACCOUNTS, vatRatePct: 15,
    docs: {
      customer_invoice: { prefix: 'INV', padding: 7 }, customer_receipt: { prefix: 'RCP', padding: 7 },
      supplier_payment: { prefix: 'PAY', padding: 7 }, quotation: { prefix: 'QUO', padding: 7 },
    },
    payroll: {
      basicComponent: {
        id: '0b000000-0000-4000-8000-000000003601', name: 'Basic Salary', sarsSourceCode: '3601', componentType: 'earning',
        isTaxable: true, isUifApplicable: true, isSdlApplicable: true,
      },
      leaveTypes: [{ id: '0c000000-0000-4000-8000-000000000001', accrualDays: 1.25 }],
    },
  };
}
