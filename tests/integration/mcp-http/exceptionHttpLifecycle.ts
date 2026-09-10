import type {Server} from 'node:http';
export async function listenExceptionServer(server:Server,port=0):Promise<void>{
 await new Promise<void>((resolve,reject)=>{
  server.once('error',reject);
  server.listen(port,'127.0.0.1',()=>{server.removeListener('error',reject);resolve();});
 });
}
export async function rethrowAfterExceptionCleanup(error:unknown,close:()=>Promise<void>):Promise<never>{
 try{await close();}catch(cleanupError){throw new AggregateError([error,cleanupError],'Synthetic exception setup and cleanup failed');}
 throw error;
}
