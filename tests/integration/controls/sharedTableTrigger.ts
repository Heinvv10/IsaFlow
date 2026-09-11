import type {Pool} from 'pg';
/** Shared by integration tests that must inject a real Postgres failure into a table other
 * sessions' tests also use (customer_invoices, control_operation_effects, ...). DDL on a shared
 * table needs an ACCESS EXCLUSIVE lock, so every statement here is bounded by a short
 * lock_timeout with retry+backoff instead of hanging on the pool's statement_timeout — a run that
 * crashes mid-test must not leave a live trigger/function to break the next run with 42710. */
async function withLockTimeoutRetry(client:{query:Pool['query']},sql:string):Promise<void>{
 let lastError:unknown;
 for(const wait of [0,250,750,1500,3000]){
  if(wait)await new Promise(resolve=>setTimeout(resolve,wait));
  try{await client.query(sql);return;}catch(error){lastError=error;}
 }
 throw lastError;
}
/** Creates a GUC-gated BEFORE INSERT trigger on `table`. `functionBody` is the plpgsql body
 * (everything between `AS $$` and `$$`), reusing the same name for the function and trigger. */
export async function createSharedTableTrigger(pool:Pool,table:string,triggerName:string,functionBody:string):Promise<void>{
 const client=await pool.connect();
 try{
  await client.query("SET lock_timeout='2s'");
  await withLockTimeoutRetry(client,`CREATE OR REPLACE FUNCTION public.${triggerName}() RETURNS trigger LANGUAGE plpgsql AS $$ ${functionBody} $$`);
  await withLockTimeoutRetry(client,`CREATE TRIGGER ${triggerName} BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION public.${triggerName}()`);
 }finally{client.release();}
}
/** Best-effort: drops the function even when the trigger drop fails, and is safe when neither
 * object exists — used both as the test's own cleanup and as a pre/post-run sweep. */
export async function dropSharedTableTrigger(pool:Pool,table:string,triggerName:string):Promise<void>{
 const client=await pool.connect();
 try{
  await client.query("SET lock_timeout='2s'");
  let triggerError:unknown;
  try{await withLockTimeoutRetry(client,`DROP TRIGGER IF EXISTS ${triggerName} ON ${table}`);}catch(error){triggerError=error;}
  await withLockTimeoutRetry(client,`DROP FUNCTION IF EXISTS public.${triggerName}()`);
  if(triggerError)throw triggerError;
 }finally{client.release();}
}
/** For a randomized-per-call trigger name that can't be recreated from a constant: sweeps every
 * leftover trigger (on one of `tables`) and function whose name starts with `prefix`, so a
 * crashed run's random name can still be found and dropped by the next beforeAll/afterAll. */
export async function sweepSharedTableTriggersByPrefix(pool:Pool,tables:readonly string[],prefix:string):Promise<void>{
 const client=await pool.connect();
 try{
  await client.query("SET lock_timeout='2s'");
  let lastError:unknown;
  const triggers=(await client.query("SELECT t.tgname,c.relname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE NOT t.tgisinternal AND t.tgname LIKE $1",[`${prefix}%`])).rows as Array<{tgname:string;relname:string}>;
  for(const row of triggers){
   if(!tables.includes(row.relname))continue;
   try{await withLockTimeoutRetry(client,`DROP TRIGGER IF EXISTS ${row.tgname} ON ${row.relname}`);}catch(error){lastError=error;}
  }
  const functions=(await client.query('SELECT proname FROM pg_proc WHERE proname LIKE $1',[`${prefix}%`])).rows as Array<{proname:string}>;
  for(const fn of functions){
   try{await withLockTimeoutRetry(client,`DROP FUNCTION IF EXISTS public.${fn.proname}()`);}catch(error){lastError=error;}
  }
  if(lastError)throw lastError;
 }finally{client.release();}
}
