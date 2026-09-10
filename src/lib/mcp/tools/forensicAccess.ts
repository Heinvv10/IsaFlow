import {z} from 'zod';
import type {McpTool} from '../types';
import {ok,toolError} from './toolHelpers';
import {requireControlTx} from '@/modules/accounting/services/controls/context';
import {canonicalJson} from '@/modules/accounting/services/controls/canonical';
import {getConnectionPermissions} from '@/modules/accounting/services/controls/connectionPermissionsService';
const empty=z.object({}).strict();
export const connectionPermissionsTool:McpTool={name:'connection_permissions',description:'Inspect this authenticated connection’s current effective rights. Conditional rights are not executable permissions.',scope:null,write:false,
 inputSchema:{type:'object',additionalProperties:false,properties:{},required:[]},
 handler:async(args)=>{
  try{empty.parse(JSON.parse(canonicalJson(args)));}catch{return toolError('Invalid connection permission arguments');}
  return ok(await getConnectionPermissions(requireControlTx()));
 }};
