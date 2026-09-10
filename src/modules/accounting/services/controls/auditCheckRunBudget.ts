export interface AuditCheckRunBudgetOptions {signal?:AbortSignal;deadlineAt:number}
/**
 * The check-run phase budget. Distinct from `indexBudget`, which silently caps every deadline at 60 s and would abort a
 * 300 s streaming run. The deadline is required and never widened: it is read through its own property descriptor, so a
 * caller getter cannot hand back a later value on a second read.
 */
export function auditCheckRunBudget(options:AuditCheckRunBudgetOptions){
 if(!options||typeof options!=='object'||Reflect.ownKeys(options).some(key=>key!=='signal'&&key!=='deadlineAt'))throw new Error('Invalid check-run budget options');
 const fields=Object.getOwnPropertyDescriptors(options);
 for(const key of ['signal','deadlineAt'])if(fields[key]&&!('value'in fields[key]!))throw new Error('Invalid check-run budget options');
 const signal=fields.signal?.value as AbortSignal|undefined,deadlineAt=fields.deadlineAt?.value as unknown;
 if(signal!==undefined&&!(signal instanceof AbortSignal))throw new Error('Invalid check-run budget signal');
 if(typeof deadlineAt!=='number'||!Number.isFinite(deadlineAt))throw new Error('Invalid check-run budget deadline');
 const aborted=Object.getOwnPropertyDescriptor(AbortSignal.prototype,'aborted')!.get!;
 return()=>{
  if(signal&&aborted.call(signal))throw new Error('Audit check run aborted');
  if(Date.now()>deadlineAt)throw new Error('Audit check run deadline exceeded');
 };
}
/**
 * The publisher lost its lease between streaming and publishing. A distinct error, so a caller — and a gate — can tell
 * which fence refused: `recheck` is the post-stream lease check, `success_pointer` the lease-fenced success UPDATE.
 */
export class CheckRunPublicationFenceError extends Error {
 constructor(readonly stage:'recheck'|'success_pointer',readonly reason:'expired'|'replaced'){
  super(`Check run publication fence (${stage}): lease ${reason}`);this.name='CheckRunPublicationFenceError';
 }
}
/** A bound the run cannot stream past. Publishing `unknown` under the same lease is the only outcome. */
export class CheckRunResourceLimitError extends Error {
 constructor(readonly reason:string){super(`Audit check run resource limit: ${reason}`);this.name='CheckRunResourceLimitError';}
}
