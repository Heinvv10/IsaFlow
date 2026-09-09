import {expect,it} from 'vitest';
import {validateMcpHttpOrigin} from './client';
import {runMcpHttpAcceptance} from './fixtures';
it('requires an explicit loopback HTTP target without credentials or redirects',()=>{
 for(const value of [undefined,'https://app.isaflow.co.za','http://127.0.0.1','http://user:secret@127.0.0.1:33219','http://127.0.0.1:33219/api/mcp','http://127.0.0.1:33219?x=1'])expect(()=>validateMcpHttpOrigin(value)).toThrow();
 expect(validateMcpHttpOrigin('http://127.0.0.1:33219')).toBe('http://127.0.0.1:33219');
});
it('verifies every declared tool structural refusal through actual local MCP HTTP',async()=>{
 const evidence=await runMcpHttpAcceptance(process.env);
 expect(evidence.toolCount).toBeGreaterThan(0);
 expect(evidence.tools).toHaveLength(evidence.toolCount);
 expect(evidence.tools.every(row=>row.inputValidation==='verified')).toBe(true);
 expect(evidence.tools.every(row=>row.scope===null||row.scopeRefusal==='verified')).toBe(true);
},600000);
