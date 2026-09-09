import {withSavepoint} from '@/lib/neon';
import {canonicalJson} from '../controls/canonical';
import {assertHistoricalImportAuthority} from '../controls/historicalImportAuthority';
import {loadSageHistoricalSnapshot} from '../controls/historicalImportSageSnapshotService';
import {extractHistoricalSageGroups} from '../controls/historicalImportSageAdapter';
import {storeHistoricalImportSource} from '../controls/historicalImportSourceService';
import {prepareHistoricalImport} from '../controls/historicalImportPreparation';
import type {ControlTx} from '../controls/contracts';
/** Server-owned staging columns are exact evidence; caller cannot choose a new economic source key. */
export async function stageSageHistoricalLedgerGroup(ctx:ControlTx,input:{accountingDate:string;reference:string|null}){
 await assertHistoricalImportAuthority(ctx,'gl','write');
 if(!input||Object.keys(input).some(key=>!['accountingDate','reference'].includes(key)))throw new Error('Invalid Sage source group selection');
 return withSavepoint('sage_historical_stage',async()=>{
  const snapshot=await loadSageHistoricalSnapshot(ctx,input.accountingDate,input.reference),bytes=Buffer.from(canonicalJson(snapshot));
  const options={sourceKey:'sage-ledger',companyId:ctx.principal.companyId},extracted=extractHistoricalSageGroups(bytes,options),group=extracted.groups[0];
  if(extracted.groups.length!==1||!group?.normalized)throw new Error(group?.error??'Sage source group is incomplete');
  const stored=await storeHistoricalImportSource(ctx,{bytes,mimeType:'application/json',artifact:{artifactVersion:2,extractor:{id:'sage_columns',version:1},
   evidenceKind:'persisted_sage_columns',extraction:{options,groupKey:group.groupKey}}});
  const prepared=await prepareHistoricalImport(ctx,{sourceSystem:'sage',sourceKey:group.normalized.sourceKey,kind:'gl',mode:'post_journal',
   accountingDate:group.normalized.accountingDate,evidenceId:stored.sourceId,sourceRecordIds:group.sourceRecordIds});
  return{...prepared,sourceId:stored.sourceId,evidenceKind:'persisted_sage_columns' as const};
 });
}
