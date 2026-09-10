import {z} from 'zod';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {assertControlTx} from './context';
import type {ControlTx} from './contracts';
import {openSnapshotIndexHeader} from './auditSnapshotIndexMaterial';
import type {SnapshotIndexEnvelope} from './auditSnapshotIndexContract';
/** Indexed metadata only. A missing historical index is explicit; reads never build it. */
export async function readAuditSnapshotIndexHeader(ctx:ControlTx,snapshotId:string){
 assertControlTx(ctx);snapshotId=z.string().uuid().parse(snapshotId).toLowerCase();await assertEffectivePermission(ctx,'read:reports');
 const rows=await ctx.sql`SELECT x.protected_header,s.canonical_hash
  FROM control_audit_snapshot_indexes x JOIN control_audit_snapshots s ON s.company_id=x.company_id AND s.id=x.snapshot_id
  JOIN control_audit_jobs j ON j.company_id=s.company_id AND j.job_id=s.job_id AND j.state='succeeded' AND j.result_snapshot_id=s.id
  WHERE x.company_id=${ctx.principal.companyId}::uuid AND x.snapshot_id=${snapshotId}::uuid` as {protected_header:SnapshotIndexEnvelope;canonical_hash:string}[];
 if(rows.length!==1||!rows[0])throw new Error('Retained snapshot index unavailable');
 const header=openSnapshotIndexHeader(rows[0].protected_header,{companyId:ctx.principal.companyId,snapshotId});
 if(header.canonicalHash!==rows[0].canonical_hash)throw new Error('Retained index identity changed');
 for(const permission of header.permissions)await assertEffectivePermission(ctx,permission);
 return header;
}
