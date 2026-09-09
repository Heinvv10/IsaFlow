import {expect,it} from 'vitest';
import {historicalImportInvoiceEvidence} from '@/modules/accounting/services/controls/historicalImportInvoiceEvidence';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
it('never permits unbound source-summary evidence reads',async()=>{
 await expect(historicalImportInvoiceEvidence({} as ControlTx,'customer_invoice','11111111-1111-4111-8111-111111111111')).rejects.toThrow();
});
