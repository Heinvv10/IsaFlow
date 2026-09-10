import {expect} from 'vitest';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {z} from 'zod';
/** Genuine legacy receipts come only from isolated worktrees pinned to these exact source commits. */
export const baselines={
 // Before deac7b7e5: effect entity_id and result.intentId keep the caller's uppercase spelling.
 upper:{env:'ISAFLOW_INTENT_CASE_BASELINE_UPPER',commit:'aad067fdb'},
 // deac7b7e5..ec0eada73: the kernel lowercases entity_id while owning services keep raw result IDs.
 window:{env:'ISAFLOW_INTENT_CASE_BASELINE_WINDOW',commit:'6228078e0'},
} as const;
export type Baseline=keyof typeof baselines;
const SEED='tests/integration/controls/intentReceiptLegacySeed.ts',CONFIG='tests/integration/controls/intentReceiptLegacySeed.config.ts';
const uuid=z.string().uuid(),identity=z.object({id:uuid,companyId:uuid});
const outcome=z.discriminatedUnion('ok',[
 z.object({ok:z.literal(true),intentId:uuid,approvalId:uuid,result:z.record(z.string(),z.unknown())}),
 z.object({ok:z.literal(false),intentId:uuid,approvalId:uuid,error:z.string()}),
]);
const seedSchema=z.object({fixture:z.object({companyA:uuid,u1:identity,u2:identity}),keys:z.object({encryption:z.string().min(1),fingerprint:z.string().min(1)}),
 ops:z.object({bank:outcome,bankOriginal:outcome,bankReversal:outcome,cash:outcome,cashReversal:outcome,compensation:outcome})});
export type LegacySeed=z.infer<typeof seedSchema>;
export type LegacyOp=keyof LegacySeed['ops'];
/** Runs the seed with the baseline's own source after proving source, migrations and fixture are exactly the pinned commit. */
export async function runLegacySeed(kind:Baseline):Promise<LegacySeed>{
 const {env,commit}=baselines[kind],cwd=process.env[env];
 if(!cwd)throw new Error(`Set ${env} to the isolated ${commit} baseline worktree containing copies of ${SEED} and ${CONFIG}`);
 const run=promisify(execFile);
 expect((await run('git',['rev-parse','--short=9','HEAD'],{cwd})).stdout.trim()).toBe(commit);
 await run('git',['diff','--exit-code',commit,'--','src','scripts/migrations/sql','tests/integration/controls/cashApplicationFixture.ts','tests/integration/forensic-fixture.ts','vitest.integration.config.ts'],{cwd});
 for(const file of [SEED,CONFIG])expect(await readFile(path.join(cwd,file),'utf8'),`${kind} baseline ${file} differs`).toBe(await readFile(path.resolve(file),'utf8'));
 const directory=await mkdtemp(path.join(tmpdir(),'isaflow-intent-seed-')),artifact=path.join(directory,'seed.json');
 const childEnv=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('VITEST')));
 try{
  await run(path.join(cwd,'node_modules/.bin/vitest'),['run','--config',CONFIG],{cwd,env:{...childEnv,ISAFLOW_INTENT_SEED_OUT:artifact},timeout:300000,maxBuffer:16*1024*1024});
  return seedSchema.parse(JSON.parse(await readFile(artifact,'utf8')));
 }finally{await rm(directory,{recursive:true,force:true});}
}
export function useSeedKeys(seed:LegacySeed){process.env.ENCRYPTION_KEY=seed.keys.encryption;process.env.CONTROL_FINGERPRINT_KEY=seed.keys.fingerprint;}
export function committed(seed:LegacySeed,op:LegacyOp){
 const outcome=seed.ops[op];
 if(!outcome.ok)throw new Error(`${op} produced no baseline receipt: ${outcome.error}`);
 return outcome;
}
