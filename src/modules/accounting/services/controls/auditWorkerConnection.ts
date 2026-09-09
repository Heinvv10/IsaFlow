import {Client,type Pool,type PoolClient} from 'pg';
/** An abandoned acquisition is released if the pool supplies it after cancellation. */
export function acquireAuditWorkerConnection(pool:Pool,deadlineAt:number,signal?:AbortSignal):Promise<PoolClient>{
 signal?.throwIfAborted();
 if(Date.now()>=deadlineAt)return Promise.reject(new Error('Audit worker resource deadline'));
 return new Promise((resolve,reject)=>{
  let settled=false;
  const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);};
  const fail=(error:unknown)=>{if(settled)return;settled=true;cleanup();reject(error);};
  const abort=()=>fail(signal?.reason??new Error('Audit worker cancelled'));
  const timer=setTimeout(()=>fail(new Error('Audit worker resource deadline')),Math.max(1,deadlineAt-Date.now()));
  signal?.addEventListener('abort',abort,{once:true});
  if(signal?.aborted){abort();return;}
  try{
   void pool.connect().then(client=>{
    if(settled){client.release();return;}
    settled=true;cleanup();resolve(client);
   },fail);
  }catch(error){fail(error);}
 });
}
/** Cancellation must not compete for the work pool's last connection. */
export async function cancelAuditWorkerBackend(pool:Pool,pid:number):Promise<void>{
 const connection=new Client({...pool.options,password:pool.options.password,connectionTimeoutMillis:1000,query_timeout:1000});
 try{await connection.connect();await connection.query('SELECT pg_cancel_backend($1)',[pid]);}
 finally{await connection.end();}
}
