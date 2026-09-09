import {createHash} from 'node:crypto';
import {hashArgs} from './audit';
import {inspectInput} from './inputValidation';
import {beginMcpInvocation,completeMcpInvocation,type InvocationCompletion} from './invocationStore';
import type {McpToolResult} from './types';
export type MarkInvocation=(completion:Omit<InvocationCompletion,'durationMs'>)=>void;
/** Never persist arguments or raw keys; malformed JSON receives a bounded sentinel hash. */
function admission(name:string,args:Record<string,unknown>){
 let argsHash=hashArgs({invalidArguments:true}),idempotencyKeyHash:string|null=null;
 try{
  inspectInput(args,true);
  argsHash=hashArgs({tool:name,args});
  const key=args.idempotency_key;
  if(typeof key==='string'&&key.trim())idempotencyKeyHash=createHash('sha256').update(key.trim()).digest('hex');
 }catch{
  argsHash=hashArgs({invalidArguments:true});idempotencyKeyHash=null;
 }
 return {tool:/^[a-z][a-z0-9_]{0,119}$/.test(name)?name:'invalid_tool_name',argsHash,idempotencyKeyHash};
}
/** Admission precedes effects. Completion is a receipt, not a claim that COMMIT succeeded. */
export async function withMcpInvocation(name:string,args:Record<string,unknown>,
 run:(mark:MarkInvocation)=>Promise<McpToolResult>):Promise<McpToolResult>{
 const started=Date.now(),handle=await beginMcpInvocation(admission(name,args));
 let completion:Omit<InvocationCompletion,'durationMs'>={status:'rejected',reportedWrite:false,reasonCode:'TOOL_REJECTED'};
 let result:McpToolResult;
 try{result=await run(value=>{completion=value;});}
 catch(error){
  await completeMcpInvocation(handle,{status:'error',reportedWrite:false,reasonCode:'HANDLER_ERROR',durationMs:Date.now()-started});
  throw error;
 }
 // Outside the catch: evidence failure must propagate to the real transaction boundary.
 await completeMcpInvocation(handle,{...completion,durationMs:Date.now()-started});
 return result;
}
