export function validateMcpHttpOrigin(value:string|undefined):string{
 if(!value)throw new Error('Explicit local MCP HTTP origin required');
 const url=new URL(value);
 if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||!url.port
  ||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('Only an explicit loopback HTTP origin is allowed');
 return url.origin;
}
export interface RpcResult {content?:Array<{type:string;text:string}>;isError?:boolean;tools?:Array<{name:string;description:string;inputSchema:Record<string,unknown>}>;serverInfo?:{name:string}}
export interface RpcReply {jsonrpc:string;id:number;result?:RpcResult;error?:{code:number;message:string}}
export function assertRpcReply(reply:RpcReply,id:number,expectedError?:number):void{
 if(reply.jsonrpc!=='2.0'||reply.id!==id)throw new Error('MCP response correlation mismatch');
 if(expectedError!==undefined){if(reply.error?.code!==expectedError||reply.result!==undefined)throw new Error('Expected exact MCP protocol error');}
 else if(reply.error||reply.result===undefined)throw new Error('Unexpected MCP protocol error or absent result');
}
/** Real HTTP only. Pace below both the per-company and per-IP production limit. */
export function mcpHttpClient(origin:string){
 const base=validateMcpHttpOrigin(origin);let sequence=0,nextRequestAt=0;
 async function request(path:string,token?:string,body?:unknown,expectedStatus=200){
  const wait=nextRequestAt-Date.now();if(wait>0)await new Promise(resolve=>setTimeout(resolve,wait));
  nextRequestAt=Date.now()+650;
  const response=await fetch(`${base}${path}`,{method:body===undefined?'GET':'POST',redirect:'error',signal:AbortSignal.timeout(30000),
   headers:{...(token?{Authorization:`Bearer ${token}`} :{}),...(body===undefined?{}:{'Content-Type':'application/json'})},
   ...(body===undefined?{}:{body:JSON.stringify(body)})});
  if(response.status!==expectedStatus)throw new Error(`Unexpected MCP HTTP status ${response.status}`);
  const reader=response.body?.getReader();if(!reader)throw new Error('Missing MCP response body');
  let length=0;const chunks:Uint8Array[]=[];
  try{for(;;){const row=await reader.read();if(row.done)break;length+=row.value.byteLength;
   if(length>4*1024*1024)throw new Error('MCP response exceeds fixture bound');chunks.push(row.value);
  }}finally{await reader.cancel();reader.releaseLock();}
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
 }
 return{
  expectedHttp:(status:number,token:string,body:unknown)=>request('/api/mcp',token,body,status),
  get:()=>request('/api/mcp') as Promise<{tools:string[]}>,
  async rpc(token:string,method:string,params?:Record<string,unknown>,expectedError?:number):Promise<RpcReply>{
   const id=++sequence,reply=await request('/api/mcp',token,{jsonrpc:'2.0',id,method,...params?{params}:{}}) as RpcReply;
   assertRpcReply(reply,id,expectedError);
   return reply;
  },
 };
}
