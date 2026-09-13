import {expect,it,vi} from 'vitest';
import {runImpersonationReaderGate,IMPERSONATION_READER_GATE_SUCCESS} from '@/lib/auth/sessionImpersonation';
import {IMPERSONATION_UNVERIFIED} from '@/lib/auth/impersonationState';

/**
 * scripts/** is outside tsconfig and no CI step runs this gate: without this test its
 * first real execution would be mid-deploy against production.
 */
it('reports success only when the database answers that both readers are executable',async()=>{
 const out=vi.fn();
 await runImpersonationReaderGate(async()=>[{reader:true,liveness:true,reader_exec:true,liveness_exec:true,reader_sees:true,liveness_sees:true,reader_sentinel:true}],out);
 expect(out).toHaveBeenCalledWith('impersonation readers present and executable by their calling roles\n');
});
it('fails the deploy when the login role cannot execute the liveness function',async()=>{
 await expect(runImpersonationReaderGate(async()=>[{reader:true,liveness:true,reader_exec:true,liveness_exec:false,reader_sees:true,liveness_sees:true,reader_sentinel:true,login_role:'app_login'}],vi.fn()))
  .rejects.toThrow(/app_login cannot EXECUTE/);
});
it('fails the deploy when the deployed reader body has lost the unverified sentinel',async()=>{
 // An older migration re-applied after 691 restores a body that answers an unreadable evidence table with
 // NULL - read as "no impersonation" - while every other property the gate checks stays true.
 const state={reader:true,liveness:true,reader_exec:true,liveness_exec:true,reader_sees:true,liveness_sees:true,reader_sentinel:false};
 await expect(runImpersonationReaderGate(async()=>[state],vi.fn()))
  .rejects.toThrow(/has been reverted to a body that reports an unreadable evidence table as "no impersonation"/);
});

it.each(['reader_sees','liveness_sees'] as const)('fails the deploy when %s says the function cannot see the evidence',async field=>{
 // 691 put RLS on both evidence tables, so a reader that is not SECURITY DEFINER, or whose owner
 // lost BYPASSRLS, silently finds nothing: every session unverified, every proof refused.
 const state={reader:true,liveness:true,reader_exec:true,liveness_exec:true,reader_sees:true,liveness_sees:true,reader_sentinel:true,[field]:false};
 await expect(runImpersonationReaderGate(async()=>[state],vi.fn()))
  .rejects.toThrow(/cannot read the impersonation evidence: it must be SECURITY DEFINER and owned by a BYPASSRLS role/);
});

/**
 * Every clause the gate depends on, asserted in the SQL TEXT. The cases above feed the row shape directly and so
 * never see the query: deleting a clause from it would leave them all passing, answering `undefined`, which the
 * gate reads as a failure only because it compares !== true. The integration tests that run this SQL against real
 * Postgres would catch a deletion, but no CI step runs them - this is the one that does.
 */
it('asks the database every question the gate decides on, in one statement',async()=>{
 const query=vi.fn(async()=>[{reader:true,liveness:true,reader_exec:true,liveness_exec:true,reader_sees:true,liveness_sees:true,reader_sentinel:true}]);
 await runImpersonationReaderGate(query,vi.fn());
 const text=String((query.mock.calls[0] as unknown as [string])[0]);
 expect(text).toContain("has_function_privilege('app_user'");
 expect(text).toContain('has_function_privilege(current_user');
 expect(text).toContain('impersonation_delegation_live(uuid,text,text,text)');
 expect(text).toContain('p.prosecdef AND COALESCE(r.rolbypassrls, false)');
 // The owner must hold SELECT on both evidence tables, or the reader raises 42501 from its own query.
 expect(text).toContain("has_table_privilege(p.proowner, 'public.admin_audit_log', 'SELECT')");
 expect(text).toContain("has_table_privilege(p.proowner, 'public.admin_impersonation_stash', 'SELECT')");
 // The deployed body must still carry the sentinel: an older migration re-applied after 691 restores a body
 // that answers an unreadable evidence table with NULL, with every other property here still true.
 expect(text).toContain(`position('${IMPERSONATION_UNVERIFIED}' in p.prosrc) > 0`);
 expect(text).toContain('AS reader_sentinel');
});

/**
 * Editing an applied migration stops the deploy at apply-migrations.ts with exit 2, BEFORE the gate above can
 * run, and clearing it is a separate command an operator has to know exists. The instruction and the claim that
 * makes it safe are asserted together: re-applying 675 is harmless only while 675 no longer defines the reader.
 */
it('tells the deployer how to clear the checksum conflict that editing 675 causes',async()=>{
 const {readFileSync}=await import('node:fs');
 const migration=readFileSync('scripts/migrations/sql/675_platform_import_approval_authority.sql','utf8');
 expect(migration).toContain('bun scripts/migrations/resolve-checksum-conflicts.ts 675_platform_import_approval_authority.sql');
 // The safety claim the note rests on: 691 owns the reader now, so re-applying 675 cannot restore the old body.
 expect(migration).not.toMatch(/(CREATE|REPLACE)\s+FUNCTION\s+public\.control_session_impersonator/i);
 // And the generic failure names the resolver, for the operator who never opens the file.
 expect(readFileSync('scripts/apply-migrations.ts','utf8'))
  .toContain('bun scripts/migrations/resolve-checksum-conflicts.ts ${plan.conflicts.map((c) => c.name).join(\' \')}');
});

it('runs the gate however the script is invoked, so a wrapped or renamed run cannot pass unchecked',async()=>{
 const {spawnSync}=await import('node:child_process');
 // Imported rather than executed directly: argv[1] is not the script's own path.
 const run=spawnSync('bun',['-e',"await import('./scripts/assert-impersonation-reader.ts')"],
  {encoding:'utf8',env:{...process.env,DATABASE_URL:''}});
 expect(run.status).not.toBe(0);
 expect(run.stderr).toContain('DATABASE_URL required');
});

it('is checked by deploy.sh against exactly the line the gate prints',async()=>{
 const {readFileSync}=await import('node:fs');
 // A drift here would block a legitimate production deploy after migrations have run.
 expect(IMPERSONATION_READER_GATE_SUCCESS).toBeTruthy();
 const deploy=readFileSync('scripts/deploy.sh','utf8');
 expect(deploy).toContain(`grep -q '^${IMPERSONATION_READER_GATE_SUCCESS}$'`);
 const out=vi.fn();
 await runImpersonationReaderGate(async()=>[{reader:true,liveness:true,reader_exec:true,liveness_exec:true,reader_sees:true,liveness_sees:true,reader_sentinel:true}],out);
 expect(out).toHaveBeenCalledWith(`${IMPERSONATION_READER_GATE_SUCCESS}\n`);
});
