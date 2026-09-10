import {createServer,type IncomingMessage} from 'node:http';
import {createHmac,randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Pool} from 'pg';
import {SignJWT} from 'jose';
import {apiResolver} from 'next/dist/server/api-utils/node/api-resolver';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget} from '../forensic-fixture';

/**
 * The AFS routes served over real HTTP through withAuth, withCsrf and the request transaction,
 * against the synthetic PostgreSQL fixture. Routes are resolved from the URL the way Next.js
 * resolves them, so a test names the document and section exactly as a browser does.
 */
const AFS='../../../pages/api/accounting/afs/[documentId]';
const ROUTES:[RegExp,string,string[]][]=[
 [/^\/api\/webhooks\/signum$/,'../../../pages/api/webhooks/signum',[]],
 [/^\/api\/accounting\/afs\/([^/]+)\/sections\/reorder$/,`${AFS}/sections/reorder`,['documentId']],
 [/^\/api\/accounting\/afs\/([^/]+)\/sections\/([^/]+)\/comments\/([^/]+)\/resolve$/,`${AFS}/sections/[sectionId]/comments/[commentId]/resolve`,['documentId','sectionId','commentId']],
 [/^\/api\/accounting\/afs\/([^/]+)\/sections\/([^/]+)\/(overrides|versions|ai-narrative|regenerate|suppress|comments|review|sign-off)$/,`${AFS}/sections/[sectionId]/$3`,['documentId','sectionId']],
 [/^\/api\/accounting\/afs\/([^/]+)\/(submit-for-review|send-for-signing|sign-off|generate)$/,`${AFS}/$2`,['documentId']],
 [/^\/api\/accounting\/afs\/brand-profile$/,'../../../pages/api/accounting/afs/brand-profile',[]],
 [/^\/api\/accounting\/companies$/,'../../../pages/api/accounting/companies',[]],
 [/^\/api\/accounting\/afs\/management-packs\/([^/]+)\/deliver$/,'../../../pages/api/accounting/afs/management-packs/[packId]/deliver',['packId']],
 [/^\/api\/accounting\/afs\/([^/]+)$/,`${AFS}/index`,['documentId']],
];
type Person='u1'|'u2';
type Module={default:unknown;config?:unknown};
export interface SeedSection{status?:string;reviewedBy?:Person|null;signedOffBy?:Person|null;overrides?:unknown;aiNarrative?:string|null;history?:boolean;
 content?:unknown;sectionType?:string;id?:string;sortOrder?:number}
export async function afsSectionHttpFixture(){
 const target=validateFixtureTarget(fixtureConfigFromEnv(process.env));
 const storage=await mkdtemp(join(tmpdir(),'afs-http-fixture-'));
 // Company edits are change-captured, and the capture encrypts: synthetic keys, this run only.
 Object.assign(process.env,{ENCRYPTION_KEY:randomBytes(32).toString('hex'),CONTROL_FINGERPRINT_KEY:randomBytes(32).toString('hex'),DATABASE_URL:target.connectionString,DATABASE_SSL:'disable',JWT_SECRET:randomBytes(32).toString('hex'),AFS_STORAGE_ROOT:storage,
  SIGNUM_API_URL:'http://signum.synthetic.invalid',SIGNUM_API_KEY:'synthetic',SIGNUM_CALLBACK_BASE_URL:'http://signum.synthetic.invalid/sign',SIGNUM_WEBHOOK_SECRET:randomBytes(16).toString('hex')});
 const pool=new Pool({connectionString:target.connectionString,ssl:false,max:4,statement_timeout:10000});
 const f=await provisionForensicFixture(fixtureConfigFromEnv(process.env)),csrf=randomBytes(32).toString('hex'),admin=randomUUID();
 // The AI and send limiters count per IP, and every run of this suite arrives from 127.0.0.1:
 // without this the second run of the day answers 429 and the suite tests the limiter instead.
 await pool.query("DELETE FROM rate_limit_counters WHERE key LIKE 'ai:afs-ai-narrative:%' OR key LIKE '%afs-signing%'");
 await pool.query("INSERT INTO users(id,email,role,is_active,status) VALUES($1,$2,'super_admin',true,'active')",[admin,`${admin}@forensic.invalid`]);
 const modules=new Map<string,Module>();
 async function resolve(req:IncomingMessage){
  const path=new URL(req.url??'/','http://synthetic').pathname;
  for(const [pattern,file,names] of ROUTES){
   const match=pattern.exec(path);if(!match)continue;
   const modulePath=path.replace(pattern,file);
   if(!modules.has(modulePath))modules.set(modulePath,await import(modulePath) as Module);
   return{module:modules.get(modulePath)!,query:Object.fromEntries(names.map((name,i)=>[name,match[i+1]!]))};
  }
  return null;
 }
 const server=createServer((req,res)=>{
  void resolve(req).then(route=>{
   if(!route){res.statusCode=404;res.end('No synthetic AFS route');return;}
   return apiResolver(req,res,route.query,route.module,{previewModeId:'synthetic',previewModeEncryptionKey:'synthetic',previewModeSigningKey:'synthetic'},true,false,req.url);
  }).catch(()=>{res.statusCode=500;res.end('Synthetic AFS HTTP failure');});
 });
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
 const address=server.address();if(!address||typeof address==='string')throw new Error('Synthetic AFS server unavailable');
 const origin=`http://127.0.0.1:${address.port}`;
 async function parse(response:Response){
  const text=await response.text();let json:unknown=null;
  try{json=JSON.parse(text);}catch(error){json={unparsed:text,error:String(error)};}
  return{status:response.status,body:json as {success?:boolean;error?:{code?:string;message?:string};data?:Record<string,unknown>;message?:string}};
 }
 /** An impersonated session: the administrator's impersonation_start row names this JWT session. */
 async function impersonatedSession(person:Person){
  const sessionId=randomUUID();
  await pool.query("INSERT INTO admin_audit_log(id,admin_user_id,action,target_type,target_id,details) VALUES($1,$2,'impersonation_start','user',$3,$4::jsonb)",
   [randomUUID(),admin,f[person].id,JSON.stringify({target_session_id:sessionId})]);
  return sessionId;
 }
 async function request(method:string,path:string,body?:unknown,person:Person='u1',sessionId?:string){
  const token=await new SignJWT({role:'authenticated',aal:'aal2',...(sessionId?{session_id:sessionId}:{})}).setProtectedHeader({alg:'HS256'}).setSubject(f[person].id).setIssuedAt().setExpirationTime('5m').sign(new TextEncoder().encode(process.env.JWT_SECRET));
  return parse(await fetch(`${origin}${path}`,{method,redirect:'error',signal:AbortSignal.timeout(30000),
   headers:{'content-type':'application/json',cookie:`sb-access-token=${token}; active_company_id=${f.companyA}; isaflow_csrf=${csrf}`,'x-csrf-token':csrf},
   ...(body===undefined?{}:{body:JSON.stringify(body)})}));
 }
 /** A Signum webhook delivery, signed with the configured secret. */
 async function webhook(payload:Record<string,unknown>){
  const raw=JSON.stringify(payload),signature=createHmac('sha256',process.env.SIGNUM_WEBHOOK_SECRET!).update(raw).digest('hex');
  return parse(await fetch(`${origin}/api/webhooks/signum`,{method:'POST',body:raw,signal:AbortSignal.timeout(30000),
   headers:{'content-type':'application/json','x-signum-signature':`sha256=${signature}`}}));
 }
 const sectionPath=(documentId:string,sectionId:string,route:string)=>`/api/accounting/afs/${documentId}/sections/${sectionId}/${route}`;
 async function document(status='draft'){
  const id=randomUUID();
  await pool.query(`INSERT INTO afs_documents(id,company_id,document_type,reporting_framework,status) VALUES($1,$2,'afs','ifrs_smes',$3)`,[id,f.companyA,status]);
  return id;
 }
 async function section(documentId:string,seed:SeedSection={}){
  // One section per type per document (uq_afs_sections_document_type), so the type is unique.
  const id=seed.id??randomUUID(),status=seed.status??'reviewed';
  const reviewer=seed.reviewedBy===undefined?(['reviewed','signed_off'].includes(status)?'u2':null):seed.reviewedBy;
  const signer=seed.signedOffBy===undefined?(status==='signed_off'?'u2':null):seed.signedOffBy;
  const history=seed.history?[{version:1,savedAt:'2024-03-01T00:00:00.000Z',savedBy:f.u1.id,content:{title:'Earlier',blocks:[]}}]:[];
  const content=seed.content===undefined?{title:'Reviewed',blocks:[]}:seed.content;
  await pool.query(`INSERT INTO afs_sections(id,document_id,company_id,section_type,status,content,overrides,ai_narrative,reviewed_by,reviewed_at,signed_off_by,signed_off_at,version_history,sort_order)
   VALUES($1,$2,$3,$10,$4,$11::jsonb,$5::jsonb,$6,$7,CASE WHEN $7::text IS NULL THEN NULL ELSE now() END,$8,CASE WHEN $8::text IS NULL THEN NULL ELSE now() END,$9::jsonb,$12)`,
   [id,documentId,f.companyA,status,seed.overrides===undefined?null:JSON.stringify(seed.overrides),seed.aiNarrative??null,reviewer?f[reviewer].id:null,signer?f[signer].id:null,
    JSON.stringify(history),seed.sectionType??`synthetic_${id.slice(0,8)}`,content===null?null:JSON.stringify(content),seed.sortOrder??0]);
  return id;
 }
 /** The firm branding the statements are rendered with. */
 const brandProfile=async()=>{await pool.query(`INSERT INTO brand_profiles(company_id,primary_colour,secondary_colour,font_family,cover_style)
  VALUES($1,'#123456','#654321','professional','classic') ON CONFLICT DO NOTHING`,[f.companyA]);};
 const read=async(id:string)=>(await pool.query(`SELECT status,content,overrides,ai_narrative,reviewed_by,reviewed_at,signed_off_by,signed_off_at,version_history,sort_order,data_snapshot
  FROM afs_sections WHERE company_id=$1 AND id=$2`,[f.companyA,id])).rows[0] as Record<string,unknown>;
 const readDocument=async(id:string)=>(await pool.query(`SELECT status,signum_document_id,signing_requested_at,signing_content_fingerprint,signing_payload_sha256,signing_refused_reason,signed_pdf_path
  FROM afs_documents WHERE company_id=$1 AND id=$2`,[f.companyA,id])).rows[0] as Record<string,unknown>;
 const audits=async(id:string)=>(await pool.query(`SELECT user_id,action,entity_type,entity_ref,changes FROM audit_log WHERE company_id=$1 AND entity_id=$2 ORDER BY created_at`,[f.companyA,id])).rows as Record<string,unknown>[];
 async function close(){
  try{await new Promise<void>((done,fail)=>{server.close(error=>error?fail(error):done());server.closeAllConnections();});}
  finally{await pool.end();await(await import('@/lib/auth/authPool')).getAuthPool().end();await(await import('@/lib/neon')).getPoolForTests().end();await rm(storage,{recursive:true,force:true});}
 }
 return{pool,f,storage,request,webhook,brandProfile,impersonatedSession,sectionPath,document,section,read,readDocument,audits,close};
}
