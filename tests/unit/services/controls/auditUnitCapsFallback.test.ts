import {beforeEach,expect,it,vi} from 'vitest';
import {execFile} from 'node:child_process';
import {readAuditUnitCaps} from '@/modules/accounting/services/controls/auditJobSystemd';
vi.mock('node:child_process',async original=>({...await original<typeof import('node:child_process')>(),execFile:vi.fn()}));
const unit='isaflow-audit-11111111-1111-4111-8111-111111111111.service';
type Callback=(error:Error|null,stdout:string)=>void;
function answer(busctl:string|Error,show:string){
 vi.mocked(execFile).mockImplementation(((file:string,_args:string[],_options:unknown,callback:Callback)=>{
  if(file==='/usr/bin/busctl'){if(busctl instanceof Error)callback(busctl,'');else callback(null,busctl);}
  else callback(null,show);
 }) as never);
}
const show='LoadState=loaded\nMemoryMax=2147483648\nMemorySwapMax=0\nMainPID=42\nRuntimeMaxUSec=5min 40s\n';
beforeEach(()=>{vi.mocked(execFile).mockReset();});
it('prefers the raw D-Bus integer over the human span',async()=>{
 answer('t 339000000\n',show);
 expect(await readAuditUnitCaps(unit)).toMatchObject({runtimeMaxUSec:339_000_000,memoryMax:'2147483648',memorySwapMax:'0'});
});
it('falls back to the parsed systemctl span only when the D-Bus read fails',async()=>{
 answer(new Error('bus unavailable'),show);
 expect((await readAuditUnitCaps(unit)).runtimeMaxUSec).toBe(340_000_000);
 answer(new Error('bus unavailable'),show.replace('5min 40s','infinity'));
 expect((await readAuditUnitCaps(unit)).runtimeMaxUSec).toBeNull();
});
