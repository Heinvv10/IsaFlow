import {expect,it} from 'vitest';
import {createServer} from 'node:http';
import {listenExceptionServer,rethrowAfterExceptionCleanup} from '../../../integration/mcp-http/exceptionHttpLifecycle';
it('rejects actual occupied-port startup instead of leaving its promise pending',async()=>{
 const first=createServer(),second=createServer();second.on('error',()=>{/* Observation listener prevents an uncaught baseline error. */});
 await new Promise<void>(resolve=>first.listen(0,'127.0.0.1',resolve));const address=first.address();if(!address||typeof address==='string')throw new Error('Missing listener');
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{const result=await Promise.race([listenExceptionServer(second,address.port).then(()=> 'listened',error=>error),new Promise(resolve=>{timer=setTimeout(()=>resolve('still pending'),100);})]);
  expect(result).toBeInstanceOf(Error);expect((result as NodeJS.ErrnoException).code).toBe('EADDRINUSE');
 }finally{if(timer)clearTimeout(timer);await new Promise<void>(resolve=>first.close(()=>resolve()));if(second.listening)await new Promise<void>(resolve=>second.close(()=>resolve()));}
});
it('preserves both original startup failure and cleanup failure',async()=>{
 const original=new Error('startup'),cleanup=new Error('cleanup');
 try{await rethrowAfterExceptionCleanup(original,async()=>{throw cleanup;});throw new Error('did not reject');}catch(error){expect(error).toBeInstanceOf(AggregateError);expect((error as AggregateError).errors).toEqual([original,cleanup]);}
});
