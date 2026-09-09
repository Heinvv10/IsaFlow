import {expect,it,vi} from 'vitest';
import {prepareHistoricalImport} from '@/modules/accounting/services/controls/historicalImportPreparation';
const mocks=vi.hoisted(()=>({assert:vi.fn(()=>{throw new Error('Authenticated control transaction required');})}));
vi.mock('@/modules/accounting/services/controls/context',()=>({assertControlTx:mocks.assert}));
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
it('refuses preparation through a fabricated actor before reading evidence or inserting intent',async()=>{
 await expect(prepareHistoricalImport({} as ControlTx,{sourceSystem:'csv',sourceKey:'source',kind:'gl',mode:'post_journal',accountingDate:'2023-02-28',evidenceId:'source',sourceRecordIds:['1','2']})).rejects.toThrow('Authenticated control transaction');
});
