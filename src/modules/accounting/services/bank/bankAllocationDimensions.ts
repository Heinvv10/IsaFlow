import type {ControlTx} from '../controls/contracts';
import type {BankAllocationPlan} from './bankAllocationPlan';
type Row={id:string;cc_type?:string;is_active:boolean;[key:string]:unknown};
/** Only selected owned classification facts join the immutable source fingerprint. */
export async function loadBankAllocationDimensions(ctx:ControlTx,plan:BankAllocationPlan){
 const selections='lines' in plan?plan.lines:'applications' in plan?[plan]:[],company=ctx.principal.companyId;
 const ccIds=[...new Set(selections.flatMap(line=>[line.cc1Id,line.cc2Id]).filter((id):id is string=>Boolean(id)))].sort();
 const buIds=[...new Set(selections.flatMap(line=>line.buId?[line.buId]:[]))].sort();
 if(!ccIds.length&&!buIds.length)return null;
 const costCentres=ccIds.length?await ctx.sql`SELECT id,company_id,code,name,cc_type,is_active,parent_id,updated_at
  FROM cost_centres WHERE company_id=${company}::uuid AND id=ANY(${ccIds}::uuid[]) ORDER BY id FOR SHARE` as Row[]:[];
 const businessUnits=buIds.length?await ctx.sql`SELECT id,company_id,code,name,is_active,updated_at
  FROM business_units WHERE company_id=${company}::uuid AND id=ANY(${buIds}::uuid[]) ORDER BY id FOR SHARE` as Row[]:[];
 if(costCentres.length!==ccIds.length||businessUnits.length!==buIds.length||[...costCentres,...businessUnits].some(row=>row.is_active!==true))throw new Error('Owned active bank dimensions required');
 for(const selected of selections){
  if(selected.cc1Id&&costCentres.find(row=>row.id===selected.cc1Id)?.cc_type!=='cc1')throw new Error('Bank CC1 dimension type is invalid');
  if(selected.cc2Id&&costCentres.find(row=>row.id===selected.cc2Id)?.cc_type!=='cc2')throw new Error('Bank CC2 dimension type is invalid');
 }
 return{costCentres,businessUnits};
}
export function bankAllocationRowDimensions(plan:BankAllocationPlan){
 const selections='lines' in plan?plan.lines:'applications' in plan?[plan]:[];
 const common=(key:'cc1Id'|'cc2Id'|'buId')=>{const values=[...new Set(selections.map(line=>line[key]??null))];return values.length===1?values[0]!:null;};
 return{cc1Id:common('cc1Id'),cc2Id:common('cc2Id'),buId:common('buId')};
}
