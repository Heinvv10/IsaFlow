import type {ControlPrincipal} from '../controls/contracts';
import type {PostingActorOpts} from '../gl/journalEntryMeta';
/** Credential provenance is issued by the request boundary, never by payload metadata. */
export function bankAllocationActor(principal:ControlPrincipal,options?:PostingActorOpts){
 if(principal.authMethod==='pat'||principal.authMethod==='oauth'){
  const token=principal.authMethod==='pat'?principal.connectionId:principal.grantId;
  if(principal.provenance!=='agent'||!token)throw new Error('Bank allocation agent credential provenance required');
  const label=options?.postingAgent;
  return{actorType:'agent' as const,actorTokenJti:token,
   postingAgent:label&&/^mcp:[a-zA-Z0-9_.-]+:v1$/.test(label)?label:'mcp:bank_allocation:v1'};
 }
 if(principal.authMethod==='job')return{actorType:'system' as const,actorTokenJti:null,postingAgent:'system:bank_allocation'};
 if(principal.provenance!=='human')throw new Error('Bank allocation human provenance required');
 return{actorType:'human' as const,actorTokenJti:null,postingAgent:`human:${principal.personId}`};
}
