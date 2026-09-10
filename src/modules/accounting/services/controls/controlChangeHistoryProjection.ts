import {canonicalJson} from './canonical';
const secret=/token|password|secret|credential|authorization|api.?key|ciphertext|account.?number|bank.?account.?no|branch.?code|routing.?number|iban|swift|bank.?fingerprint|details.?fingerprint|card.?number|^cvv$|^cvc$|^pin$/i;
/** Preserve exact authorized data; name every intentionally withheld secret path. */
export function projectHistoryValues(input:{before:Record<string,unknown>|null;after:Record<string,unknown>|null}){
 const exact=JSON.parse(canonicalJson(input)) as typeof input,redactedPaths:string[]=[];
 if(!exact||typeof exact!=='object'||Object.keys(exact).sort().join(',')!=='after,before'
  ||[exact.before,exact.after].some(value=>value!==null&&(typeof value!=='object'||Array.isArray(value))))throw new Error('Invalid protected history shape');
 const walk=(value:unknown,path:string):unknown=>{
  if(Array.isArray(value))return value.map((item,index)=>walk(item,`${path}/${index}`));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>{
   const next=`${path}/${key.replaceAll('~','~0').replaceAll('/','~1')}`;
   if(secret.test(key)||(key==='fingerprint'&&/beneficiar|bank/i.test(path))){redactedPaths.push(next);return[key,'[REDACTED]'];}return[key,walk(item,next)];
  }));return value;
 };
 return{before:walk(exact.before,'/before') as typeof input.before,after:walk(exact.after,'/after') as typeof input.after,redactedPaths:redactedPaths.sort()};
}
