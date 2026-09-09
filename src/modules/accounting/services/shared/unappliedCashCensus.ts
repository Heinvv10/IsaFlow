export interface CashPopulationCoverage {
 sourceCount:number;analyzedCount:number;recognizedRemainderCount:number;fullyAppliedCount:number;inactiveCount:number;unresolvedCount:number;
}
/** A caller must supply the independent database census, never a detail-array fallback. */
export function beginCashPopulation(source:Record<string,unknown>[],sourceCount:number):CashPopulationCoverage{
 if(!Number.isSafeInteger(sourceCount)||sourceCount<0||sourceCount>100000||source.length!==sourceCount)
  throw new Error('Cash history population does not match independent census or exceeds bound');
 const ids=new Set<string>();
 for(const row of source){
  if(typeof row.id!=='string'||!row.id||ids.has(row.id))throw new Error('Cash history population contains missing or duplicate payment identity');
  ids.add(row.id);
 }
 return{sourceCount,analyzedCount:0,recognizedRemainderCount:0,fullyAppliedCount:0,inactiveCount:0,unresolvedCount:0};
}
export function reconcileCashPopulation(population:CashPopulationCoverage){
 const classified=population.recognizedRemainderCount+population.fullyAppliedCount+population.inactiveCount+population.unresolvedCount;
 if(population.analyzedCount!==population.sourceCount||classified!==population.sourceCount)
  throw new Error('Cash history disposition population does not match independent census');
}
