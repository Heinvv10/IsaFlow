import {expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {contractCases} from './contractCases';
import {contractSample,type Contract} from './contractSamples';
import {validateToolArguments} from '@/lib/mcp/inputValidation';
import type {McpTool} from '@/lib/mcp/types';
import {MCP_TOOLS} from '@/lib/mcp/toolIndex';
import {CLIENT_MCP_TOOL_NAMES} from '@/lib/mcp/clientMetadata';
import {flowOperationFor} from '@/lib/mcp/flowMetering';
import {AUDIT_CHECK_RUN_IDS} from '@/modules/accounting/services/controls/auditCheckRunContract';
const NAMES=['run_control_checks','control_check_run','control_check_run_findings'] as const;
const inventory=()=>JSON.parse(readFileSync('docs/superpowers/plans/forensic-evidence/tool-contract-current.json','utf8')) as {counts:{total:number};tools:Contract[]};
it('registers the three check-run tools in the index, the client list and the flow-operation map',()=>{
 for(const name of NAMES){
  const tool=MCP_TOOLS.find(entry=>entry.name===name);
  expect(tool,`${name} is not registered in toolIndex`).toBeDefined();
  expect(tool!.scope,`${name} does not require read:reports`).toBe('read:reports');
  expect(tool!.write,`${name} write flag is wrong`).toBe(name==='run_control_checks');
  expect(CLIENT_MCP_TOOL_NAMES,`${name} is missing from CLIENT_MCP_TOOL_NAMES`).toContain(name);
  // A missing flow entry bills nothing forever; forensic controls are deliberately free, never absent.
  expect(flowOperationFor(name,{}),`${name} has no explicit flow-operation decision`).toBeNull();
 }
 expect(MCP_TOOLS.find(entry=>entry.name==='run_control_checks')!.perUserIdempotency).toBe(true);
});
it('exports the three check-run tools into the frozen contract inventory with matching counts',()=>{
 const frozen=inventory();
 expect(frozen.counts.total,'the exported inventory was not regenerated').toBe(frozen.tools.length);
 expect(frozen.tools.length).toBe(MCP_TOOLS.length);
 for(const name of NAMES){
  const row=frozen.tools.find(tool=>tool.name===name);
  expect(row,`${name} is absent from tool-contract-current.json`).toBeDefined();
  expect(row!.input_schema.additionalProperties,`${name} accepts unknown properties`).toBe(false);
 }
 const run=frozen.tools.find(tool=>tool.name==='run_control_checks')!;
 const checks=(run.input_schema.properties as Record<string,{items?:{enum?:string[]};maxItems?:number}>).checks;
 expect(checks?.items?.enum,'run_control_checks does not offer exactly the runnable checks').toEqual([...AUDIT_CHECK_RUN_IDS]);
 expect(run.input_schema.required).toEqual(expect.arrayContaining(['cutoff','checks','idempotency_key']));
});
it('enumerates deterministic structural refusals for every field of the three check-run tools',()=>{
 const frozen=inventory(),failures:string[]=[],ids=new Set<string>();
 for(const name of NAMES){
  const tool=frozen.tools.find(entry=>entry.name===name)!;
  // The required-only sample must itself be accepted, or every refusal below is measured against a broken baseline.
  const accepted=validateToolArguments({name:tool.name,write:tool.write,inputSchema:tool.input_schema} as McpTool,contractSample(tool));
  expect(accepted.ok,`${name}: structural sample gap: ${accepted.ok?'':accepted.message}`).toBe(true);
  const cases=contractCases(tool);
  expect(cases.length,`${name} produced no structural cases`).toBeGreaterThan(0);
  for(const row of cases){
   expect(ids.has(row.id),row.id).toBe(false);ids.add(row.id);
   const result=validateToolArguments({name:tool.name,write:tool.write,inputSchema:tool.input_schema} as McpTool,row.args);
   if(result.ok!==(row.kind==='compatibility'))failures.push(`${row.id}: unexpected ${JSON.stringify(result)}`);
   if(!result.ok&&result.message!==row.expected)failures.push(`${row.id}: ${result.message} != ${row.expected}`);
  }
 }
 expect(failures).toEqual([]);
 expect([...ids].some(id=>id.startsWith('control_check_run_findings:limit:maximum'))).toBe(true);
 expect([...ids].some(id=>id.startsWith('run_control_checks:cutoff:format'))).toBe(true);
});
