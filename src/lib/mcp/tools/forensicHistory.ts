import {z} from 'zod';
import type {McpTool} from '../types';
import {ok,toolError} from './toolHelpers';
import {requireControlTx} from '@/modules/accounting/services/controls/context';
import {canonicalJson} from '@/modules/accounting/services/controls/canonical';
import {readControlEntityHistory} from '@/modules/accounting/services/controls/controlChangeHistoryService';
import {HISTORY_ENTITY_TYPES} from '@/modules/accounting/services/controls/controlChangeHistoryPolicy';
import {listMcpInvocations} from '@/lib/mcp/invocationHistory';
import {inspectTransactionEvidence} from '@/modules/accounting/services/controls/transactionEvidenceService';
import {EVIDENCE_TYPES} from '@/modules/accounting/services/controls/transactionEvidenceTypes';
const limit=z.number().int().min(1).max(100).optional(),cursor=z.string().min(1).max(2048).optional();
const fields={entity_type:z.string().min(1).max(80),entity_id:z.string().min(1).max(80),limit,cursor};
const history=z.object(fields).strict(),calls=z.object({after_id:z.string().uuid().optional(),limit}).strict(),graph=history.extend({entity_type:z.enum(EVIDENCE_TYPES),entity_id:z.string().uuid()}).strict();
const pageProperties={limit:{type:'integer',minimum:1,maximum:100},cursor:{type:'string',minLength:1,maxLength:2048}};
function tool<T>(name:string,description:string,scope:string|null,properties:Record<string,unknown>,required:string[],schema:z.ZodType<T>,run:(input:T)=>Promise<unknown>):McpTool{
 return{name,description,scope,write:false,inputSchema:{type:'object',additionalProperties:false,properties,required},handler:async(args)=>{
  let input;try{input=schema.parse(JSON.parse(canonicalJson(args)));}catch{return toolError('Invalid history arguments');}
  return ok(await run(input));
 }};
}
const changes=tool('entity_change_history','Read exact authorized committed change evidence with explicit secret redactions, recorded actor IDs and historical gaps. Follow the signed version cursor; missing legacy evidence is not reconstructed.', 'read:audit',
 {entity_type:{type:'string',enum:[...HISTORY_ENTITY_TYPES]},entity_id:{type:'string',minLength:1,maxLength:80},...pageProperties},['entity_type','entity_id'],history,
 async({entity_type,entity_id,...options})=>readControlEntityHistory(requireControlTx(),{entityType:entity_type,entityId:entity_id,...options}));
const invocations=tool('mcp_call_history','Read sanitized recorded MCP attempts and outcomes in UUID order. Missing final outcomes remain unknown; this read does not reconcile them. Follow nextAfterId.', 'read:audit',
 {after_id:{type:'string',format:'uuid'},limit:pageProperties.limit},[],calls,
 async({after_id,...options})=>listMcpInvocations(requireControlTx(),{...(after_id===undefined?{}:{afterId:after_id}),...options}));
const chain=tool('transaction_evidence_chain','Read a bounded current graph of recorded accounting relationships. Coverage describes the visited population, not complete historical assurance or verified document bytes. Continue with nextCursor.',null,
 {entity_type:{type:'string',enum:[...EVIDENCE_TYPES]},entity_id:{type:'string',format:'uuid'},...pageProperties},['entity_type','entity_id'],graph,
 async({entity_type,entity_id,...options})=>inspectTransactionEvidence(requireControlTx(),{entityType:entity_type,entityId:entity_id,...options}));
export const forensicHistoryTools=[changes,invocations,chain] as const;
