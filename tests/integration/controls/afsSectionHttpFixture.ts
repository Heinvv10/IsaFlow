import {createServer,type IncomingMessage} from 'node:http';
import {randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {SignJWT} from 'jose';
import {apiResolver} from 'next/dist/server/api-utils/node/api-resolver';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget} from '../forensic-fixture';

/**
 * The AFS section routes served over real HTTP through withAuth, withCsrf and the request
 * transaction, against the synthetic PostgreSQL fixture. Routes are resolved from the URL the
 * way Next.js resolves them, so a test names the document and section exactly as a browser does.
 */
const SECTION_ROUTES=['overrides','versions','ai-narrative','regenerate','suppress'] as const;
type Person='u1'|'u2';
export interface SeedSection{status?:string;reviewedBy?:Person|null;signedOffBy?:Person|null;overrides?:unknown;aiNarrative?:string|null;history?:boolean}
export async function afsSectionHttpFixture(){
 const target=validateFixtureTarget(fixtureConfigFromEnv(process.env));
 process.env.DATABASE_URL=target.connectionString;process.env.DATABASE_SSL='disable';
 process.env.JWT_SECRET=randomBytes(32).toString('hex');
 const pool=new Pool({connectionString:target.connectionString,ssl:false,max:4,statement_timeout:10000});
 const f=await provisionForensicFixture(fixtureConfigFromEnv(process.env)),csrf=randomBytes(32).toString('hex');
 const handlers:Record<string,unknown>={};
 for(const name of SECTION_ROUTES)handlers[name]=(await import(`../../../pages/api/accounting/afs/[documentId]/sections/[sectionId]/${name}`)).default;
 handlers['submit-for-review']=(await import('../../../pages/api/accounting/afs/[documentId]/submit-for-review')).default;
 function resolve(req:IncomingMessage){
  const path=new URL(req.url??'/','http://synthetic').pathname;
  const section=/^\/api\/accounting\/afs\/([^/]+)\/sections\/([^/]+)\/([^/]+)$/.exec(path);
  if(section)return{handler:handlers[section[3]!],query:{documentId:section[1]!,sectionId:section[2]!}};
  const doc=/^\/api\/accounting\/afs\/([^/]+)\/([^/]+)$/.exec(path);
  return doc?{handler:handlers[doc[2]!],query:{documentId:doc[1]!}}:{handler:undefined,query:{}};
 }
 const server=createServer((req,res)=>{
  const {handler,query}=resolve(req);
  if(!handler){res.statusCode=404;res.end('No synthetic AFS route');return;}
  void apiResolver(req,res,query,{default:handler},{previewModeId:'synthetic',previewModeEncryptionKey:'synthetic',previewModeSigningKey:'synthetic'},true,false,req.url)
   .catch(()=>{res.statusCode=500;res.end('Synthetic AFS HTTP failure');});
 });
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
 const address=server.address();if(!address||typeof address==='string')throw new Error('Synthetic AFS server unavailable');
 const origin=`http://127.0.0.1:${address.port}`;
 async function request(method:string,path:string,body?:unknown,person:Person='u1'){
  const token=await new SignJWT({role:'authenticated',aal:'aal2'}).setProtectedHeader({alg:'HS256'}).setSubject(f[person].id).setIssuedAt().setExpirationTime('5m').sign(new TextEncoder().encode(process.env.JWT_SECRET));
  const response=await fetch(`${origin}${path}`,{method,redirect:'error',signal:AbortSignal.timeout(30000),
   headers:{'content-type':'application/json',cookie:`sb-access-token=${token}; active_company_id=${f.companyA}; isaflow_csrf=${csrf}`,'x-csrf-token':csrf},
   ...(body===undefined?{}:{body:JSON.stringify(body)})});
  const text=await response.text();let json:unknown=null;
  try{json=JSON.parse(text);}catch(error){json={unparsed:text,error:String(error)};}
  return{status:response.status,body:json as {success?:boolean;error?:{code?:string;message?:string};data?:Record<string,unknown>}};
 }
 const sectionPath=(documentId:string,sectionId:string,route:string)=>`/api/accounting/afs/${documentId}/sections/${sectionId}/${route}`;
 async function document(status='draft'){
  const id=randomUUID();
  await pool.query(`INSERT INTO afs_documents(id,company_id,document_type,reporting_framework,status) VALUES($1,$2,'afs','ifrs_smes',$3)`,[id,f.companyA,status]);
  return id;
 }
 async function section(documentId:string,seed:SeedSection={}){
  // One section per type per document (uq_afs_sections_document_type), so the type is unique.
  const id=randomUUID(),status=seed.status??'reviewed';
  const reviewer=seed.reviewedBy===undefined?(['reviewed','signed_off'].includes(status)?'u2':null):seed.reviewedBy;
  const signer=seed.signedOffBy===undefined?(status==='signed_off'?'u2':null):seed.signedOffBy;
  const history=seed.history?[{version:1,savedAt:'2024-03-01T00:00:00.000Z',savedBy:f.u1.id,content:{title:'Earlier',blocks:[]}}]:[];
  await pool.query(`INSERT INTO afs_sections(id,document_id,company_id,section_type,status,content,overrides,ai_narrative,reviewed_by,reviewed_at,signed_off_by,signed_off_at,version_history)
   VALUES($1,$2,$3,$10,$4,'{"title":"Reviewed","blocks":[]}'::jsonb,$5::jsonb,$6,$7,CASE WHEN $7::text IS NULL THEN NULL ELSE now() END,$8,CASE WHEN $8::text IS NULL THEN NULL ELSE now() END,$9::jsonb)`,
   [id,documentId,f.companyA,status,seed.overrides===undefined?null:JSON.stringify(seed.overrides),seed.aiNarrative??null,reviewer?f[reviewer].id:null,signer?f[signer].id:null,JSON.stringify(history),`synthetic_${id.slice(0,8)}`]);
  return id;
 }
 const read=async(id:string)=>(await pool.query(`SELECT status,content,overrides,ai_narrative,reviewed_by,reviewed_at,signed_off_by,signed_off_at,version_history
  FROM afs_sections WHERE company_id=$1 AND id=$2`,[f.companyA,id])).rows[0] as Record<string,unknown>;
 const audits=async(id:string)=>(await pool.query(`SELECT user_id,action,entity_type,entity_ref,changes FROM audit_log WHERE company_id=$1 AND entity_id=$2 ORDER BY created_at`,[f.companyA,id])).rows as Record<string,unknown>[];
 async function close(){
  try{await new Promise<void>((done,fail)=>{server.close(error=>error?fail(error):done());server.closeAllConnections();});}
  finally{await pool.end();await(await import('@/lib/auth/authPool')).getAuthPool().end();await(await import('@/lib/neon')).getPoolForTests().end();}
 }
 return{pool,f,request,sectionPath,document,section,read,audits,close};
}
