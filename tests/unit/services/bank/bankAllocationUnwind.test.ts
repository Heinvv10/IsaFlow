/** Raw mutation entry points are retired. Actual economic inverse checks live in
 * integration/controls/legacyVoidControls.int.test.ts and bankSettlementMetadata.int.test.ts:
 * relative balances, dated settlement metadata, cancellation, retained original rows and rollback.
 */
import {it,expect} from 'vitest';
import {unwindOnePayment,unwindBankAllocationApplication} from '@/modules/accounting/services/bank/bankAllocationUnwind';
for(const kind of ['customer','supplier'] as const)it(`raw ${kind} unwind cannot synthesize approval from IDs`,async()=>{
 await expect(unwindOnePayment('company',kind,'payment')).rejects.toThrow('Approved controlled cash or payment inverse required');
});
it('journal-wide raw unwind cannot erase sibling payment history',async()=>{
 await expect(unwindBankAllocationApplication('company','journal')).rejects.toThrow('Approved controlled bank or payment inverse required');
});
