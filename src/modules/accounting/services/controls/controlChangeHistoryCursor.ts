import {createHmac,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import {canonicalJson} from './canonical';
const schema=z.object({version:z.literal(1),companyId:z.string().uuid(),entityType:z.string().min(1).max(80),entityId:z.string().min(1).max(80),permissionsHash:z.string().regex(/^[a-f0-9]{64}$/),throughVersion:z.number().int().nonnegative().safe(),lastVersion:z.number().int().nonnegative().safe()}).strict();
export type HistoryCursor=z.infer<typeof schema>;
function sign(encoded:string){const key=process.env.CONTROL_FINGERPRINT_KEY;if(!key||key.length<32)throw new Error('History cursor key unavailable');return createHmac('sha256',key).update('isaflow:change-history:v1\0').update(encoded).digest();}
export function sealHistoryCursor(input:HistoryCursor){const encoded=Buffer.from(canonicalJson(schema.parse(input))).toString('base64url');return `${encoded}.${sign(encoded).toString('hex')}`;}
export function openHistoryCursor(value:string):HistoryCursor{
 if(value.length>2048)throw new Error('Invalid history cursor');const [encoded,mac,...rest]=value.split('.');
 if(rest.length||!encoded||!mac||!/^[A-Za-z0-9_-]+$/.test(encoded)||!/^[a-f0-9]{64}$/.test(mac)||!timingSafeEqual(sign(encoded),Buffer.from(mac,'hex')))throw new Error('Invalid history cursor');
 const bytes=Buffer.from(encoded,'base64url');if(bytes.toString('base64url')!==encoded)throw new Error('Invalid history cursor');
 const result=schema.parse(JSON.parse(bytes.toString('utf8')));if(result.lastVersion>result.throughVersion)throw new Error('Invalid history cursor');return result;
}
