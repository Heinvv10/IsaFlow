import {expect,it} from 'vitest';
import {parseAuditWorkerArguments} from '@/modules/accounting/services/controls/auditWorkerArguments';
const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222';
it('keeps the legacy defaults and the repeatable --company form',()=>{
 expect(parseAuditWorkerArguments(['--company',a,'--company',b,'--once'])).toEqual({companyIds:[a,b],once:true,intervalMs:5000,batchSize:10,workerClass:'audit'});
});
it('takes a unit-supplied company list as one comma-separated word',()=>{
 expect(parseAuditWorkerArguments(['--class','check_run',`--companies=${a},${b}`])).toMatchObject({companyIds:[a,b],workerClass:'check_run',once:false});
});
it('refuses a repeated option so a later value cannot switch the class or mode',()=>{
 for(const argv of [['--class','check_run','--class','audit','--company',a],['--company',a,'--once','--once'],['--companies',a,'--companies',b],
  ['--company',a,'--interval-ms','5000','--interval-ms','1000'],['--company',a,'--batch-size','1','--batch-size','10']])
  expect(()=>parseAuditWorkerArguments(argv)).toThrow(/repeated/i);
});
it('refuses a company list that smuggles options or mixes both forms',()=>{
 for(const value of [`${a} --class audit`,`${a},--once`,`${a},,${b}`,'','not-a-uuid'])
  expect(()=>parseAuditWorkerArguments(['--class','check_run','--companies',value])).toThrow();
 expect(()=>parseAuditWorkerArguments(['--company',a,'--companies',b])).toThrow(/either/i);
 expect(()=>parseAuditWorkerArguments(['--class','admin','--company',a])).toThrow(/class/i);
 expect(()=>parseAuditWorkerArguments(['--company',a,'positional'])).toThrow();
});
