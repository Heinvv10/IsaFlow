import {createHash} from 'node:crypto';
import {setImmediate} from 'node:timers/promises';
import {canonicalJson} from './canonical';
import {verifyAuditSnapshot,type SealedAuditSnapshot} from './auditSnapshotSeal';
import {deriveIndexPermissions,indexBudget} from './auditSnapshotIndexValidation';
import {COMPARISON_SECTIONS,makeComparisonItem,type ComparisonItem,type ComparisonSection,type ComparisonOptions} from './auditSnapshotComparisonMaterial';
const hash=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
/** Authenticate retained metadata without loading original binary artifacts. No current source rows are consulted. */
export async function createComparisonProjection(sealed:SealedAuditSnapshot,expected:{companyId:string;snapshotId:string},permissions:string[],options?:ComparisonOptions){
 const check=indexBudget(options);check();
 // Verify synchronously before the first yield; retain only this detached authenticated body during construction.
 const snapshot=verifyAuditSnapshot(sealed,expected),required=deriveIndexPermissions(snapshot,permissions);
 const canonicalHash=hash(snapshot);check();
 const sections:Record<ComparisonSection,ComparisonItem[]>={records:[],checks:[],evidence:[],evidenceGaps:[]};
 const counts:Record<ComparisonSection,number>={records:0,checks:0,evidence:0,evidenceGaps:0};
 let consumed=0;
 for(const section of COMPARISON_SECTIONS){
  const values=snapshot[section]??[],items=sections[section];
  for(let ordinal=0;ordinal<values.length;ordinal++){
   check();const item=makeComparisonItem(section,values[ordinal],ordinal);
   Object.freeze(item.identity);Object.freeze(item);items.push(item);
   if(++consumed%64===0){await setImmediate();check();}
  }
  items.sort((a,b)=>{const x=canonicalJson(a.identity),y=canonicalJson(b.identity);return x<y?-1:x>y?1:0;});
  check();counts[section]=items.length;Object.freeze(items);
 }
 check();
 return Object.freeze({version:1 as const,companyId:snapshot.companyId,snapshotId:snapshot.snapshotId,canonicalHash,
  cutoff:snapshot.cutoff,capturedAt:snapshot.capturedAt,populationsHash:hash(snapshot.populations),coverageHash:hash([snapshot.coverage,snapshot.missingSources]),
  permissions:Object.freeze(required),counts:Object.freeze(counts),sections:Object.freeze(sections)});
}
