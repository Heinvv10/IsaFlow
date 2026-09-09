import {createHash} from 'node:crypto';
import {z} from 'zod';
import {assertControlTx} from './context';
import type {ControlTx} from './contracts';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {canonicalJson} from './canonical';
import type {AuditSnapshotData} from './auditSnapshotSeal';
import {querySnapshotEvidence} from './auditSnapshotEvidenceQuerySql';
export type {SnapshotEvidenceRelation} from './auditSnapshotEvidenceQuerySql';
const permissions:Record<string,string>={journal_entry:'read:reports',journal_line:'read:reports',
 customer_invoice:'read:invoices',customer_invoice_line:'read:invoices',customer_payment:'read:invoices',customer_payment_allocation:'read:invoices',
 sage_supplier_invoice:'read:invoices',supplier_invoice:'read:invoices',supplier_invoice_line:'read:invoices',supplier_payment:'read:invoices',supplier_payment_allocation:'read:invoices',
 bank_transaction:'read:bank-tx',bank_statement_import:'read:bank-tx',bank_statement_attestation_intent:'read:bank-tx',payroll_run:'read:payroll',payroll_run_line:'read:payroll'};
const source=z.string().refine(value=>Object.hasOwn(permissions,value),'Unknown snapshot source');
const body=z.object({version:z.literal(1),companyId:z.string().uuid(),snapshotId:z.string().uuid(),cutoff:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),capturedAt:z.string().datetime(),
 records:z.array(z.object({source,id:z.string().uuid(),version:z.number().int().positive().nullable(),data:z.record(z.string(),z.unknown())}).strict()).max(100000),
 populations:z.array(z.object({source,count:z.number().int().min(0).max(100000),excludedCount:z.number().int().min(0).max(100000),exclusions:z.array(z.string())}).strict()).max(16),
 checks:z.array(z.unknown()).max(6),evidence:z.array(z.unknown()).max(100000),coverage:z.array(z.string()),missingSources:z.array(z.string())}).strict();
const optionsSchema=z.object({cursor:z.string().min(1).max(2048).optional(),limit:z.number().int().min(1).max(1000).optional()}).strict();
const cursorSchema=z.object({binding:z.string().regex(/^[a-f0-9]{64}$/),key:z.string().min(1).max(512)}).strict();
/** Called inside the same repeatable-read transaction as capture, before root retains bytes and seals. */
export async function discoverSnapshotEvidence(ctx:ControlTx,input:AuditSnapshotData,options:{cursor?:string;limit?:number}={}){
 assertControlTx(ctx);
 const encoded=canonicalJson(input);if(Buffer.byteLength(encoded)>100*1024*1024)throw new Error('Snapshot evidence input resource limit');
 const saved=body.parse(JSON.parse(encoded)),opts=optionsSchema.parse(JSON.parse(canonicalJson(options)));
 if(saved.companyId!==ctx.principal.companyId)throw new Error('Snapshot evidence tenant mismatch');
 const refs=saved.records.map(({source,id})=>({source,id})).sort((a,b)=>a.source<b.source?-1:a.source>b.source?1:a.id<b.id?-1:a.id>b.id?1:0);
 const identities=new Set<string>(),counts=new Map<string,number>();
 for(const ref of refs){const key=`${ref.source}|${ref.id}`;if(identities.has(key))throw new Error('Duplicate snapshot source');identities.add(key);counts.set(ref.source,(counts.get(ref.source)??0)+1);}
 const declared=new Set<string>();
 for(const p of saved.populations){if(declared.has(p.source)||(counts.get(p.source)??0)!==p.count)throw new Error('Snapshot population incomplete');declared.add(p.source);counts.delete(p.source);}
 if(counts.size)throw new Error('Undeclared snapshot source');
 const binding=createHash('sha256').update(canonicalJson({snapshotId:saved.snapshotId,companyId:saved.companyId,cutoff:saved.cutoff,refs,populations:saved.populations})).digest('hex');
 const cursor=opts.cursor?cursorSchema.parse(JSON.parse(Buffer.from(opts.cursor,'base64url').toString())):null;
 if(cursor&&cursor.binding!==binding)throw new Error('Evidence cursor belongs to another snapshot');
 const [isolation]=await ctx.sql`SELECT current_setting('transaction_isolation') AS value` as {value:string}[];
 if(isolation?.value!=='repeatable read')throw new Error('Evidence discovery requires repeatable read');
 for(const permission of new Set(['read:reports',...saved.populations.map(p=>permissions[p.source]!)]))await assertEffectivePermission(ctx,permission);
 const limit=opts.limit??1000,result=await querySnapshotEvidence(ctx,refs,cursor?.key??null,limit);
 if(result.root_count!==refs.length)throw new Error('Snapshot source parent unavailable or foreign');
 if(result.count>100000)throw new Error('Evidence relation population resource limit');
 const page=result.rows.slice(0,limit),last=page.at(-1);
 const nextCursor=result.rows.length>limit&&last?Buffer.from(canonicalJson({binding,key:last.key})).toString('base64url'):null;
 return{relationCount:result.count,relations:page.map(({key:_key,...row})=>row),nextCursor};
}
