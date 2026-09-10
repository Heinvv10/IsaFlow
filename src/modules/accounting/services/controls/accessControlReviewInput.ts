import {z} from 'zod';
import {canonicalJson} from './canonical';
const kind=z.enum(['membership','pat','oauth']);
export type AccessReviewKind=z.infer<typeof kind>;
const schema=z.object({kind,limit:z.number().int().min(1).max(100).default(20),dormantDays:z.number().int().min(1).max(3650).default(90),cursor:z.string().min(1).max(2000).optional()}).strict();
const continuation=z.object({version:z.literal(1),company:z.string().uuid(),kind,dormantDays:z.number().int().min(1).max(3650),after:z.string().min(1).max(200)}).strict();
/** Position is untrusted pagination input. Every page must independently authenticate. */
export function parseAccessReviewInput(value:unknown,companyId:string){
 const input=schema.parse(JSON.parse(canonicalJson(value)));let after:string|null=null;
 if(input.cursor){
  if(!/^[A-Za-z0-9_-]+$/.test(input.cursor))throw new Error('Invalid access review cursor');
  const buffer=Buffer.from(input.cursor,'base64url');if(buffer.toString('base64url')!==input.cursor)throw new Error('Invalid access review cursor');
  const cursor=continuation.parse(JSON.parse(buffer.toString('utf8')));
  if(cursor.company!==companyId||cursor.kind!==input.kind||cursor.dormantDays!==input.dormantDays)throw new Error('Access review cursor does not match request');
  after=cursor.after;
 }
 return{kind:input.kind,limit:input.limit,dormantDays:input.dormantDays,after};
}
export type AccessReviewInput=ReturnType<typeof parseAccessReviewInput>;
export function accessReviewCursor(company:string,reviewKind:AccessReviewKind,dormantDays:number,after:string){
 return Buffer.from(canonicalJson(continuation.parse({version:1,company,kind:reviewKind,dormantDays,after}))).toString('base64url');
}
