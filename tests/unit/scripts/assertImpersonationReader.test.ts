import {expect,it,vi} from 'vitest';
import {runImpersonationReaderGate} from '@/lib/auth/sessionImpersonation';

/**
 * scripts/** is outside tsconfig and no CI step runs this gate: without this test its
 * first real execution would be mid-deploy against production.
 */
it('reports success only when the database answers that both readers are executable',async()=>{
 const out=vi.fn();
 await runImpersonationReaderGate(async()=>[{reader:true,liveness:true,reader_exec:true,liveness_exec:true}],out);
 expect(out).toHaveBeenCalledWith('impersonation readers present and executable by their calling roles\n');
});
it('fails the deploy when the login role cannot execute the liveness function',async()=>{
 await expect(runImpersonationReaderGate(async()=>[{reader:true,liveness:true,reader_exec:true,liveness_exec:false,login_role:'app_login'}],vi.fn()))
  .rejects.toThrow(/app_login cannot EXECUTE/);
});
it('asks the database the questions in one statement, for the roles that really call each function',async()=>{
 const query=vi.fn(async()=>[{reader:true,liveness:true,reader_exec:true,liveness_exec:true}]);
 await runImpersonationReaderGate(query,vi.fn());
 const text=String((query.mock.calls[0] as unknown as [string])[0]);
 expect(text).toContain("has_function_privilege('app_user'");
 expect(text).toContain('has_function_privilege(current_user');
 expect(text).toContain('impersonation_delegation_live(uuid,text,text,text)');
});

it('runs the gate however the script is invoked, so a wrapped or renamed run cannot pass unchecked',async()=>{
 const {spawnSync}=await import('node:child_process');
 // Imported rather than executed directly: argv[1] is not the script's own path.
 const run=spawnSync('bun',['-e',"await import('./scripts/assert-impersonation-reader.ts')"],
  {encoding:'utf8',env:{...process.env,DATABASE_URL:''}});
 expect(run.status).not.toBe(0);
 expect(run.stderr).toContain('DATABASE_URL required');
});
