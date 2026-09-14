import {expect,it} from 'vitest';
import {readdirSync,readFileSync} from 'node:fs';

/**
 * Migration 839 must be the ONLY migration that defines or alters control_session_impersonator().
 *
 * 826 defined it before 839, with a body that answers an unreadable evidence table with NULL -
 * which resolveImpersonatingActor reads as "nobody is impersonating", the fail-open 839 closed.
 * Two definitions in two files means the later apply wins, so re-running the older one silently
 * reinstates it: resolve-checksum-conflicts.ts on an amended migration, a rebuilt database, or the
 * renumbering against master. One definition is what makes apply order stop mattering.
 *
 * This lives in tests/unit because it has to RUN. Its first home was the controls integration
 * suite, which scripts/ci/run-ci.sh only runs when DATABASE_URL is set, behind a fixture target
 * check and a provisioned fixture - none of which this needs. The deploy gate
 * (assertImpersonationReaderDeployed) catches a reinstated body in a database; this catches it in
 * the repository, before anyone deploys.
 */
const DIR='scripts/migrations/sql';
/**
 * Anything that could define or redirect the function: CREATE [OR REPLACE] FUNCTION and ALTER
 * FUNCTION, with or without the public. qualifier and with whitespace anywhere a parser allows it
 * (`public . control_session_impersonator`). ALTER counts because OWNER TO or SECURITY INVOKER
 * changes the answer without touching the body.
 */
const TOUCHES=/(?:CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION|ALTER\s+FUNCTION)\s+(?:public\s*\.\s*)?control_session_impersonator/i;

it('leaves migration 839 as the only migration that defines or alters the impersonation reader',()=>{
 const touching=readdirSync(DIR).filter(name=>name.endsWith('.sql')&&TOUCHES.test(readFileSync(`${DIR}/${name}`,'utf8')));
 expect(touching).toEqual(['839_impersonation_evidence_integrity.sql']);
});

it('matches the spellings a reintroduction would realistically use',()=>{
 // The predicate itself, proved on strings rather than trusted: an unqualified CREATE, whitespace
 // around the dot, a lowercase create or replace, and a bare ALTER all have to count.
 for(const spelling of ['CREATE FUNCTION control_session_impersonator()',
  'CREATE OR REPLACE FUNCTION public . control_session_impersonator()',
  'create or replace function public.control_session_impersonator()',
  'ALTER FUNCTION public.control_session_impersonator() OWNER TO app_user',
  'ALTER FUNCTION control_session_impersonator() SECURITY INVOKER',
  'CREATE\n  FUNCTION\n  public.control_session_impersonator()']){
  expect(TOUCHES.test(spelling),spelling).toBe(true);
 }
 // And a mere call or a grant is not a definition, or 828 and every caller would match.
 for(const spelling of ['SELECT public.control_session_impersonator() AS actor',
  'GRANT EXECUTE ON FUNCTION public.control_session_impersonator() TO app_user',
  'DROP FUNCTION IF EXISTS public.control_session_impersonator()']){
  expect(TOUCHES.test(spelling),spelling).toBe(false);
 }
});
