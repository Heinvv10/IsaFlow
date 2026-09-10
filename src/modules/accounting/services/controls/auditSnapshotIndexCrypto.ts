import {createCipheriv,createDecipheriv,createHash,createHmac,pbkdf2Sync,randomBytes,timingSafeEqual} from 'node:crypto';
import {canonicalJson} from './canonical';
import type {SnapshotIndexEnvelope} from './auditSnapshotIndexContract';
export type IndexDomain='header'|'item'|'chunk'|'export-header'|'export-file'|'export-chunk'|'comparison-source-header'|'comparison-source-item';
let cached:{secret:string;key:Buffer}|undefined;
export const indexHash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
function detachEnvelope(input:SnapshotIndexEnvelope):SnapshotIndexEnvelope{
 if(!input||typeof input!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(input)))throw new Error('Invalid index envelope');
 const names=Reflect.ownKeys(input);
 if(names.length!==4||names.some(name=>!['version','keyId','ciphertext','authentication'].includes(String(name))))throw new Error('Invalid index envelope');
 const values:Record<string,unknown>={};
 for(const name of names){const field=Object.getOwnPropertyDescriptor(input,name)!;
  if(typeof name!=='string'||!field.enumerable||!('value'in field))throw new Error('Invalid index envelope');values[name]=field.value;}
 if(values.version!==1||typeof values.keyId!=='string'||values.keyId.length>256
  ||typeof values.ciphertext!=='string'||values.ciphertext.length>800000
  ||typeof values.authentication!=='string'||!/^[a-f0-9]{64}$/.test(values.authentication))throw new Error('Invalid index envelope');
 return values as unknown as SnapshotIndexEnvelope;
}
/** Same key derivation/format as existing encryption, cached once per current secret, never per index row. */
export function indexCryptography(){
 const secret=process.env.ENCRYPTION_KEY,signing=process.env.CONTROL_SNAPSHOT_SIGNING_KEY;
 if(!secret||secret.length<32||!signing||signing.length<32)throw new Error('Independent index encryption and signing keys required');
 if(cached?.secret!==secret){cached?.key.fill(0);cached={secret,key:pbkdf2Sync(secret,'isaflow-encryption-salt',100000,32,'sha256')};}
 const key=Buffer.from(cached.key),keyId=process.env.CONTROL_ENCRYPTION_KEY_ID??'current',signingKeyId=process.env.CONTROL_SNAPSHOT_KEY_ID??'current';
 if(!keyId||keyId.length>256||!signingKeyId||signingKeyId.length>256)throw new Error('Invalid index key identity');
 const authenticate=(domain:IndexDomain,ciphertext:string)=>createHmac('sha256',signing)
  .update(canonicalJson({domain:`isaflow:snapshot-index:${domain}:v1`,keyId,signingKeyId,ciphertext})).digest('hex');
 return{
  seal(domain:IndexDomain,value:unknown):SnapshotIndexEnvelope{
   const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
   const encrypted=Buffer.concat([cipher.update(canonicalJson(value),'utf8'),cipher.final()]);
   const ciphertext=`${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${encrypted.toString('hex')}`;
   return{version:1,keyId,ciphertext,authentication:authenticate(domain,ciphertext)};
  },
  open(domain:IndexDomain,input:SnapshotIndexEnvelope):unknown{
   const envelope=detachEnvelope(input);
   if(Object.keys(envelope).sort().join(',')!=='authentication,ciphertext,keyId,version'||envelope.version!==1||envelope.keyId!==keyId
    ||typeof envelope.ciphertext!=='string'||envelope.ciphertext.length>800000
    ||typeof envelope.authentication!=='string'||!/^[a-f0-9]{64}$/.test(envelope.authentication)
    ||!timingSafeEqual(Buffer.from(envelope.authentication,'hex'),Buffer.from(authenticate(domain,envelope.ciphertext),'hex')))throw new Error('Index envelope authentication failed');
   const parts=envelope.ciphertext.split(':');
   if(parts.length!==3||!/^[a-f0-9]{24}$/.test(parts[0]!)||!/^[a-f0-9]{32}$/.test(parts[1]!)||!/^([a-f0-9]{2})+$/.test(parts[2]!))throw new Error('Invalid index ciphertext');
   const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(parts[0]!,'hex'));decipher.setAuthTag(Buffer.from(parts[1]!,'hex'));
   return JSON.parse(Buffer.concat([decipher.update(Buffer.from(parts[2]!,'hex')),decipher.final()]).toString('utf8')) as unknown;
  },
 };
}
