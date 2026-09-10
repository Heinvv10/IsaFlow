import {createHash} from 'node:crypto';
import {canonicalJson} from './canonical';
import {COMPARISON_SECTIONS,type ComparisonChange} from './auditSnapshotComparisonMaterial';
import type {ComparisonResultHeader} from './auditComparisonResultProtection';
/** Bounded digest of authenticated, ordered output. Publication remains conditional on source and lease checks. */
export function createComparisonResultDigest(){
 const hash=createHash('sha256').update('isaflow.audit-comparison-result.v1\n');
 const counts=Object.fromEntries(COMPARISON_SECTIONS.map(section=>[section,{added:0,removed:0,changed:0}])) as
  Record<typeof COMPARISON_SECTIONS[number],{added:number;removed:number;changed:number}>;
 let lastSection=-1,lastKey='',finished=false;
 const active=()=>{if(finished)throw new Error('Comparison digest already finalized');};
 return{
  append(change:ComparisonChange):void{
   active();const section=COMPARISON_SECTIONS.indexOf(change.section),key=canonicalJson(change.identity);
   if(section<0||section<lastSection||(section===lastSection&&key<=lastKey))throw new Error('Comparison output order changed');
   if(!['added','removed','changed'].includes(change.kind))throw new Error('Comparison output kind changed');
   const seen=counts[change.section],position=seen.added+seen.removed+seen.changed;
   if(position>=200012)throw new Error('Comparison output exceeds supported population');
   hash.update(canonicalJson({section:change.section,position,change})+'\n');
   seen[change.kind]++;lastSection=section;lastKey=key;
  },
  finish(header:ComparisonResultHeader):string{
   active();finished=true;
   for(const section of COMPARISON_SECTIONS){
    const expected=header.counts[section],actual=counts[section];
    if(expected.added!==actual.added||expected.removed!==actual.removed||expected.changed!==actual.changed
     ||expected.first!==expected.removed+expected.changed+expected.unchanged
     ||expected.second!==expected.added+expected.changed+expected.unchanged)throw new Error('Comparison output count mismatch');
   }
   // Job UUID, attempt/lease and this digest are excluded so retries over identical sources reproduce the same content hash.
   hash.update(canonicalJson({version:header.version,comparisonRuleVersion:header.comparisonRuleVersion,companyId:header.companyId,
    first:header.first,second:header.second,permissions:header.permissions,counts:header.counts,
    populationChanged:header.populationChanged,coverageChanged:header.coverageChanged})+'\n');
   return hash.digest('hex');
  },
 };
}
