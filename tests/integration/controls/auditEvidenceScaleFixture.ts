import {createServer} from 'node:http';
import {createHash,randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import type {Pool} from 'pg';
export const ORIGINAL_BYTES=10*1024*1024;
export type Original={id:string;byteLength:number;sha256:string};
/** Synthetic originals are streamed, never fetched from external URLs or pre-sealed. */
export async function evidenceScaleStorage(){
 const objects=new Map<string,{length:number;fill:number}>();let requests=0;
 const names=['SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY','SUPABASE_CAPTURED_DOCS_BUCKET'] as const;
 const saved=names.map(name=>process.env[name]);
 const key='synthetic-evidence-scale-storage-key';
 const server=createServer((req,res)=>{
  const item=objects.get(req.url??'');requests++;
  if(!item||req.headers.apikey!==key||req.headers.authorization!==`Bearer ${key}`){res.writeHead(404);res.end();return;}
  res.writeHead(200,{'content-length':item.length,'content-type':'application/octet-stream'});
  const blocks=function*(){const block=Buffer.alloc(65536,item.fill);for(let left=item.length;left>0;left-=block.length)yield block.subarray(0,Math.min(left,block.length));};
  void pipeline(Readable.from(blocks()),res).catch(()=>res.destroy());
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address();if(!address||typeof address==='string')throw new Error('Synthetic storage listener unavailable');
 process.env.SUPABASE_URL=`http://127.0.0.1:${address.port}`;process.env.SUPABASE_SERVICE_ROLE_KEY=key;process.env.SUPABASE_CAPTURED_DOCS_BUCKET='captured-documents';
 return{
  get requests(){return requests;},
  async seed(pool:Pool,company:string,length:number,fill:number):Promise<Original>{
   const id=randomUUID(),bank=randomUUID(),account=randomUUID(),hash=createHash('sha256'),block=Buffer.alloc(65536,fill);
   for(let left=length;left>0;left-=block.length)hash.update(block.subarray(0,Math.min(left,block.length)));
   const sha256=hash.digest('hex');
   await pool.query("INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,level) VALUES($1,$2,left($1::uuid::text,20),'Synthetic evidence bank','asset','debit',3)",[account,company]);
   await pool.query("INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount) VALUES($1,$2,$3,'2026-09-09',1)",[bank,company,account]);
   await pool.query("INSERT INTO captured_documents(id,company_id,status,file_name,file_type,matched_bank_tx_id,storage_bucket,storage_path,raw_bytes_sha256,raw_bytes_size) VALUES($1,$2,'matched','synthetic.bin','pdf',$3,'captured-documents',$4,$5,$6)",[id,company,bank,`${company}/${id}`,sha256,length]);
   objects.set(`/storage/v1/object/captured-documents/${company}/${id}`,{length,fill});return{id:`captured:${id}`,byteLength:length,sha256};
  },
  async close(){
   try{await new Promise<void>((resolve,reject)=>{server.close(error=>error?reject(error):resolve());server.closeAllConnections();});}
   finally{names.forEach((name,i)=>{if(saved[i]===undefined)delete process.env[name];else process.env[name]=saved[i];});}
  },
 };
}
