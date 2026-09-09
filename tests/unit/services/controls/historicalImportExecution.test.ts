import {expect,it} from 'vitest';
import {executeHistoricalImport} from '@/modules/accounting/services/controls/historicalImportExecution';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
it('rejects a fabricated historical executor context before any financial SQL',async()=>{
 await expect(executeHistoricalImport({} as ControlTx,{entityType:'historical_import',entityId:'11111111-1111-4111-8111-111111111111',operation:'historical_import.post'})).rejects.toThrow();
});
