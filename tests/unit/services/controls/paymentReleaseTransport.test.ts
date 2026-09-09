import {afterEach,expect,it,vi} from 'vitest';
import {submitEftBatch,getSubmissionStatus} from '@/modules/accounting/services/ap/netcashService';
afterEach(()=>vi.unstubAllGlobals());
it('legacy raw submit cannot bypass the committed release service, even with credentials',async()=>{
 const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
 await expect(submitEftBatch('','',[])).rejects.toThrow('release');
 await expect(submitEftBatch('synthetic-service','synthetic-payout',[])).rejects.toThrow('release');
 expect(fetch).not.toHaveBeenCalled();
});
it('missing status credentials cannot fabricate provider processing',async()=>{
 const result=await getSubmissionStatus('','id');expect(result.status).toBe('unknown');expect(result.mock).not.toBe(true);
});
