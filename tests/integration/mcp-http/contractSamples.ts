import {validateToolArguments} from '@/lib/mcp/inputValidation';
import type {McpTool} from '@/lib/mcp/types';
export interface Contract {name:string;scope:string|null;write:boolean;requires_post:boolean;input_schema:Record<string,unknown>}
export interface Schema {
 type?:string|string[];properties?:Record<string,Schema>;required?:string[];items?:Schema;enum?:unknown[];
 minimum?:number;maximum?:number;exclusiveMinimum?:number;minItems?:number;maxItems?:number;
 minLength?:number;maxLength?:number;format?:string;pattern?:string;
}
export const SAMPLE_UUID='11111111-1111-4111-8111-111111111111';
/** Samples prove structural gate reachability, never ownership or business validity. */
export function sample(schema:Schema):unknown{
 if(schema.enum)return schema.enum[0];
 const type=Array.isArray(schema.type)?schema.type.find(value=>value!=='null')??'null':schema.type;
 if(type==='object')return Object.fromEntries((schema.required??[]).map(key=>{
  const child=schema.properties?.[key];if(!child)throw new Error(`Missing required property schema: ${key}`);
  return[key,sample(child)];
 }));
 if(type==='array')return Array.from({length:schema.minItems??0},()=>sample(schema.items!));
 if(type==='number'||type==='integer')return Math.max(schema.minimum??0,(schema.exclusiveMinimum??-1)+1);
 if(type==='boolean')return false;if(type==='null')return null;
 if(type!=='string')throw new Error(`Unsupported sample type: ${String(type)}`);
 if(schema.format==='date')return '2026-09-09';
 if(schema.format==='uuid')return SAMPLE_UUID;
 const candidates=['sample','0','1.00','123456','123456789','a'.repeat(64),'x'.repeat(schema.minLength??1)];
 const value=candidates.find(value=>value.length>=(schema.minLength??0)&&value.length<=(schema.maxLength??Infinity)
  &&(!schema.pattern||new RegExp(schema.pattern).test(value)));
 if(value===undefined)throw new Error(`No explicit bounded sample for pattern ${schema.pattern??'<none>'}`);
 return value;
}
export function contractSample(tool:Contract):Record<string,unknown>{
 const args=sample(tool.input_schema) as Record<string,unknown>;
 if(tool.write)args.idempotency_key='http-contract-sample';
 if(tool.name==='prepare_bank_operation')args.instruction={action:'prepare_allocate',bankTransactionId:SAMPLE_UUID,allocationType:'account',contraAccountId:SAMPLE_UUID};
 if(tool.name==='execute_bank_operation')args.instruction={action:'allocate',bankTransactionId:SAMPLE_UUID,intent_id:SAMPLE_UUID,approval_id:SAMPLE_UUID};
 const validation=validateToolArguments({name:tool.name,write:tool.write,inputSchema:tool.input_schema} as McpTool,args);
 if(!validation.ok)throw new Error(`${tool.name}: structural sample gap: ${validation.message}`);
 return args;
}
