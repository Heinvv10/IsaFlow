import {z} from 'zod';
import type {McpTool} from '../types';
import {ok,toolError} from './toolHelpers';
import {requireControlTx} from '@/modules/accounting/services/controls/context';
import {canonicalJson} from '@/modules/accounting/services/controls/canonical';
import {getConnectionPermissions} from '@/modules/accounting/services/controls/connectionPermissionsService';
import {reviewAccessControl} from '@/modules/accounting/services/controls/accessControlReviewService';
const empty=z.object({}).strict();
export const connectionPermissionsTool:McpTool={name:'connection_permissions',description:'Inspect this authenticated connection’s current effective rights. Conditional rights are not executable permissions.',scope:null,write:false,
 inputSchema:{type:'object',additionalProperties:false,properties:{},required:[]},
 handler:async(args)=>{
  try{empty.parse(JSON.parse(canonicalJson(args)));}catch{return toolError('Invalid connection permission arguments');}
  return ok(await getConnectionPermissions(requireControlTx()));
 }};
const review=z.object({kind:z.enum(['membership','pat','oauth']),limit:z.number().int().min(1).max(100).optional(),cursor:z.string().min(1).max(2000).optional(),dormant_days:z.number().int().min(1).max(3650).optional()}).strict();
export const accessControlReviewTool:McpTool={name:'access_control_review',description:'Review one live page of tenant membership or credential metadata with an independent owned census, current role/scope conflicts and observed dormancy. No secret tokens; follow nextCursor. Pages are not an immutable snapshot.',scope:'read:access',write:false,
 inputSchema:{type:'object',additionalProperties:false,properties:{kind:{type:'string',enum:['membership','pat','oauth']},limit:{type:'integer',minimum:1,maximum:100},cursor:{type:'string',minLength:1,maxLength:2000},dormant_days:{type:'integer',minimum:1,maximum:3650}},required:['kind']},
 handler:async(args)=>{
  let input;try{input=review.parse(JSON.parse(canonicalJson(args)));}catch{return toolError('Invalid access review arguments');}
  const {dormant_days,...options}=input;
  return ok(await reviewAccessControl(requireControlTx(),{...options,...dormant_days===undefined?{}:{dormantDays:dormant_days}}));
 }};
