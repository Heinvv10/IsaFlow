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
 // An older migration re-applied after 739 restores a body that answers an unreadable evidence table with
 // NULL - read as "no impersonation" - while every other property the gate checks stays true.
 const state={reader:true,liveness:true,reader_exec:true,liveness_exec:true,reader_sees:true,liveness_sees:true,reader_sentinel:false};
 await expect(runImpersonationReaderGate(async()=>[state],vi.fn()))
  .rejects.toThrow(/has been reverted to a body that reports an unreadable evidence table as "no impersonation"/);
});

it.each(['reader_sees','liveness_sees'] as const)('fails the deploy when %s says the function cannot see the evidence',async field=>{
 // 739 put RLS on both evidence tables, so a reader that is not SECURITY DEFINER, whose owner lost
 // BYPASSRLS, or whose owner lost SELECT, cannot read them: every session unverified, every proof
 // refused - and in the lost-SELECT case the reader would raise 42501 instead of answering.
 const state={reader:true,liveness:true,reader_exec:true,liveness_exec:true,reader_sees:true,liveness_sees:true,reader_sentinel:true,[field]:false};
 await expect(runImpersonationReaderGate(async()=>[state],vi.fn()))
  .rejects.toThrow(/cannot read the impersonation evidence: it must be SECURITY DEFINER, and its owner must both bypass RLS and hold SELECT on admin_audit_log and admin_impersonation_stash/);
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
 // The deployed body must still RETURN the sentinel: an older migration re-applied after 739 restores a body
 // that answers an unreadable evidence table with NULL, with every other property here still true. Matched on
 // the RETURN with comments stripped, because a plain substring over prosrc is satisfied by a comment.
 expect(text).toContain(`~ 'RETURN\\s+''${IMPERSONATION_UNVERIFIED}'''`);
 expect(text).toContain("regexp_replace(p.prosrc, '/\\*.*?\\*/', '', 'gs')");
 expect(text).toContain("'--[^\\n]*', '', 'g'");
 expect(text).toContain('AS reader_sentinel');
});

/**
 * Both files were edited after they had been applied, and until the 2026-09-14 renumbering their DEPLOY NOTEs
 * told the operator to clear a checksum conflict. Renumbering killed that premise: apply-migrations.ts keys on
 * FILENAME, so a database carrying the OLD name has no row for the new one, raises no conflict, and applies the
 * file in full - resolve-checksum-conflicts.ts would have nothing to resolve. An instruction to run a command
 * that does nothing is worse than none, because the operator concludes the step succeeded. This asserts the note
 * no longer carries it, and the two claims the replacement rests on.
 */
it('does not tell the deployer to resolve a checksum conflict the renumbering made impossible',async()=>{
 const {readFileSync}=await import('node:fs');
 const read=(f:string)=>readFileSync(`scripts/migrations/sql/${f}`,'utf8');
 const notes={
  '726_platform_import_approval_authority.sql':read('726_platform_import_approval_authority.sql'),
  '728_impersonation_delegation_liveness.sql':read('728_impersonation_delegation_liveness.sql'),
 };
 for(const [name,text] of Object.entries(notes)){
  // No runnable resolver command for THIS file: the old note's whole instruction was that line.
  expect(text,name).not.toContain(`bun scripts/migrations/resolve-checksum-conflicts.ts ${name}`);
  // And the note says what happens instead, so the operator is not left to infer it.
  expect(text,name).toMatch(/tracks migrations by FILENAME|tracks by FILENAME/);
  expect(text,name).toContain('applies this file IN FULL');
 }
 // The safety claim the replacement rests on: 739 owns the reader now, so re-applying 726 cannot restore the
 // fail-open body. This is the assertion that has to survive, whatever the note says.
 expect(notes['726_platform_import_approval_authority.sql'])
  .not.toMatch(/(CREATE|REPLACE)\s+FUNCTION\s+public\.control_session_impersonator/i);
 // The generic conflict failure still names the resolver, for migrations that ARE edited after apply under an
 // unchanged name - the renumbering removed the instruction from two files, not the mechanism.
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
