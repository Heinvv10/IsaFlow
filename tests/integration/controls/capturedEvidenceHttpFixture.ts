import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
/** Actual local object transport; only owned synthetic routes return seeded bytes. */
export async function capturedEvidenceHttpFixture(){
 const objects=new Map<string,Buffer>();let requests=0;
 const keys=['SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY','SUPABASE_CAPTURED_DOCS_BUCKET'] as const;
 const saved=keys.map(key=>process.env[key]);
 const server=createServer((request,response)=>{
  requests++;const bytes=objects.get(request.url??'');
  response.writeHead(bytes?200:404);response.end(bytes??'Missing synthetic object');
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address();if(!address||typeof address==='string')throw new Error('Synthetic storage unavailable');
 process.env.SUPABASE_URL=`http://127.0.0.1:${address.port}`;
 process.env.SUPABASE_SERVICE_ROLE_KEY='synthetic-local-storage-key';process.env.SUPABASE_CAPTURED_DOCS_BUCKET='captured-documents';
 const path=(company:string,id:string)=>`/storage/v1/object/captured-documents/${company}/${id}`;
 return{
  get requests(){return requests;},
  put(company:string,id:string,bytes:Buffer){objects.set(path(company,id),Buffer.from(bytes));},
  remove(company:string,id:string){objects.delete(path(company,id));},
  async seed(db:Pool|PoolClient,company:string,id:string,bytes:Buffer){
   objects.set(path(company,id),Buffer.from(bytes));
   const hash=createHash('sha256').update(bytes).digest('hex');
   await db.query("UPDATE captured_documents SET storage_bucket='captured-documents',storage_path=$3,raw_bytes_sha256=$4,raw_bytes_size=$5 WHERE company_id=$1 AND id=$2",[company,id,`${company}/${id}`,hash,bytes.length]);
   return hash;
  },
  async close(){
   server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
   keys.forEach((key,index)=>{if(saved[index]===undefined)delete process.env[key];else process.env[key]=saved[index];});
  },
 };
}
