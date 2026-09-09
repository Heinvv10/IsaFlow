import { afterAll,beforeAll,expect,it,vi } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import nlQuery from '../../pages/api/accounting/nl-query';
import { encryptToken } from '../../src/lib/encryption';
import { assertDisposable,request,response } from './mfa-impersonation-postgres.helpers';
assertDisposable();
const pool=new Pool({connectionString:process.env.DATABASE_URL});
const first=crypto.randomUUID(),second=crypto.randomUUID(),user=crypto.randomUUID();
const companies=[first,second];let token='',generatedSQL='';
const originalFetch=globalThis.fetch;
beforeAll(async()=>{
  vi.stubEnv('ANTHROPIC_API_KEY','disposable-provider-fixture');
  vi.stubEnv('ENCRYPTION_KEY','disposable-nl-query-encryption-key-over-32-characters');
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2),($3,$4)',[first,'NL query fixture',second,'Foreign NL fixture']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'viewer',true)",[user,`${user}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'manager')",[first,user]);
  await pool.query('INSERT INTO webhook_endpoints(company_id,name,url,secret) VALUES($1,$2,$3,$4),($1,$5,$3,$6),($7,$8,$3,$9)',[first,'Legacy fixture','http://127.0.0.1/unused','disposable-legacy-signing-secret','Encrypted fixture',encryptToken('disposable-new-signing-secret'),second,'Foreign fixture','disposable-foreign-secret']);
  await pool.query('INSERT INTO customers(company_id,name) VALUES($1,$2),($3,$4)',[first,'Owned NL customer',second,'Foreign NL customer']);
  token=await new SignJWT({sub:user,aal:'aal2'}).setProtectedHeader({alg:'HS256'}).setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
  vi.stubGlobal('fetch',async(input:Parameters<typeof fetch>[0],init?:Parameters<typeof fetch>[1])=>{
    const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
    if(url.href==='https://api.anthropic.com/v1/messages')return new Response(JSON.stringify({content:[{text:JSON.stringify({sql:generatedSQL,explanation:'Disposable provider output'})}]}),{status:200,headers:{'content-type':'application/json'}});
    if(!['localhost','127.0.0.1'].includes(url.hostname))throw new Error('External network forbidden in disposable NL fixture');
    return originalFetch(input,init);
  });
});
afterAll(async()=>{
  vi.unstubAllGlobals();vi.unstubAllEnvs();
  try{
    await pool.query('DELETE FROM webhook_endpoints WHERE company_id=ANY($1::uuid[])',[companies]);
    await pool.query('DELETE FROM customers WHERE company_id=ANY($1::uuid[])',[companies]);
    await pool.query('DELETE FROM company_users WHERE company_id=ANY($1::uuid[])',[companies]);
    await pool.query('DELETE FROM companies WHERE id=ANY($1::uuid[])',[companies]);
    await pool.query('DELETE FROM users WHERE id=$1',[user]);
    await pool.query('DELETE FROM rate_limit_counters WHERE key=ANY($1::text[])',[[`ai:nl-query:co:${first}`,`ai:nl-query:co:${first}:day`,'ai:nl-query:ip:127.0.0.81']]);
  }finally{await pool.end();}
});
async function ask(sql:string){
  generatedSQL=sql;const req=request({'sb-access-token':token,active_company_id:first},'POST');
  req.socket.remoteAddress='127.0.0.81';req.url='/api/accounting/nl-query';req.body={question:'Show requested financial records'};
  const result=response();await nlQuery(req,result.res);return result;
}
it('blocks quoted non-allowlisted endpoint rows including legacy plaintext and current ciphertext',async()=>{
  const result=await ask(`SELECT name,secret FROM "webhook_endpoints" WHERE company_id='${first}'`);
  expect(result.state.statusCode).toBe(200);
  expect(JSON.stringify(result.state.body)).not.toContain('disposable-legacy-signing-secret');
  expect(result.state.body).toMatchObject({data:{summary:'Query rejected',rows:[]}});
});
it('still returns quoted allowed customer rows only for the selected company',async()=>{
  const result=await ask(`SELECT name FROM "customers" WHERE company_id='${first}'`);
  expect(result.state.statusCode).toBe(200);
  expect(result.state.body).toMatchObject({data:{rows:[{name:'Owned NL customer'}]}});
});
it('rejects a foreign tenant predicate through the existing AST scope control',async()=>{
  const result=await ask(`SELECT name FROM "customers" WHERE company_id='${second}'`);
  expect(JSON.stringify(result.state.body)).not.toContain('Foreign NL customer');
  expect(result.state.body).toMatchObject({data:{rows:[]}});
});
