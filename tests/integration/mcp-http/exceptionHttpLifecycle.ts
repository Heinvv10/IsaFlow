import type {Server} from 'node:http';
export async function listenExceptionServer(server:Server,port=0):Promise<void>{
 await new Promise<void>(resolve=>server.listen(port,'127.0.0.1',resolve));
}
export async function rethrowAfterExceptionCleanup(error:unknown,close:()=>Promise<void>):Promise<never>{await close();throw error;}
