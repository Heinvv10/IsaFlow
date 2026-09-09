import {expect,it,vi} from 'vitest';
import {Pool} from 'pg';
import {cancelAuditWorkerBackend} from '@/modules/accounting/services/controls/auditWorkerConnection';
const observed=vi.hoisted(()=>({options:{} as Record<string,unknown>}));
vi.mock('pg',async original=>({...await original<typeof import('pg')>(),Client:class{
 constructor(options:Record<string,unknown>){observed.options=options;}
 async connect(){}
 async query(){return{rows:[]};}
 async end(){}
}}));
it.each(['synthetic-only-password',async()=>'synthetic-only-password'])('preserves private pool password configuration on its cancellation connection',async password=>{
 const pool=new Pool({host:'127.0.0.1',user:'synthetic',password,database:'synthetic'});
 try{
  expect(Object.getOwnPropertyDescriptor(pool.options,'password')?.enumerable).toBe(false);
  await cancelAuditWorkerBackend(pool,42);
  expect(observed.options.password).toBe(password);
  expect(observed.options.connectionTimeoutMillis).toBe(1000);
 }finally{await pool.end();}
});
