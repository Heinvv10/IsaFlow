import {expect,it,vi} from 'vitest';
import {runImpersonationReaderGate} from '../../../scripts/assert-impersonation-reader';

/**
 * scripts/** is outside tsconfig and no CI step runs this gate: without this test its
 * first real execution would be mid-deploy against production.
 */
it('reports success only when the database answers that both readers are executable',async()=>{
 const out=vi.fn();
 await runImpersonationReaderGate(async()=>[{reader:true,liveness:true,reader_exec:true,liveness_exec:true}],out);
 expect(out).toHaveBeenCalledWith('impersonation readers present and executable by app_user\n');
});
it('fails the deploy when app_user cannot execute the liveness function',async()=>{
 await expect(runImpersonationReaderGate(async()=>[{reader:true,liveness:true,reader_exec:true,liveness_exec:false}],vi.fn()))
  .rejects.toThrow(/app_user/);
});
it('asks the database the four questions in one statement',async()=>{
 const query=vi.fn(async()=>[{reader:true,liveness:true,reader_exec:true,liveness_exec:true}]);
 await runImpersonationReaderGate(query,vi.fn());
 const text=String((query.mock.calls[0] as unknown as [string])[0]);
 expect(text).toContain("has_function_privilege('app_user'");
 expect(text).toContain('impersonation_delegation_live(uuid,text,text,text)');
});
