import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import type {Pool} from 'pg';
/** Local synthetic bytes only; close listener before sockets for both Node and Bun. */
export async function bankBrowserEvidenceFixture(){
 const objects=new Map<string,Buffer>();
 const keys=['SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY','SUPABASE_CAPTURED_DOCS_BUCKET'] as const;
 const saved=keys.map(key=>process.env[key]);
 const server=createServer((request,response)=>{const bytes=objects.get(request.url??'');response.writeHead(bytes?200:404);response.end(bytes??'Missing synthetic evidence');});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address();if(!address||typeof address==='string')throw new Error('Local evidence server unavailable');
 process.env.SUPABASE_URL=`http://127.0.0.1:${address.port}`;
 process.env.SUPABASE_SERVICE_ROLE_KEY='synthetic-local-storage-key';process.env.SUPABASE_CAPTURED_DOCS_BUCKET='captured-documents';
 return{
  async seed(db:Pool,company:string,id:string,bytes:Buffer){
   objects.set(`/storage/v1/object/captured-documents/${company}/${id}`,Buffer.from(bytes));
   const hash=createHash('sha256').update(bytes).digest('hex');
   await db.query('UPDATE captured_documents SET storage_bucket=\'captured-documents\',storage_path=$3,raw_bytes_sha256=$4,raw_bytes_size=$5 WHERE company_id=$1 AND id=$2',[company,id,`${company}/${id}`,hash,bytes.length]);return hash;
  },
  async close(){
   try{await new Promise<void>((resolve,reject)=>{server.close(error=>error?reject(error):resolve());server.closeAllConnections();});}
   finally{keys.forEach((key,index)=>{if(saved[index]===undefined)delete process.env[key];else process.env[key]=saved[index];});}
  },
 };
}
