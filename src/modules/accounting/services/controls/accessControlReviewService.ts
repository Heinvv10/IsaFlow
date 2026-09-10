import type {ControlTx} from './contracts';
import {parseAccessReviewInput,accessReviewCursor} from './accessControlReviewInput';
import {readAccessReviewMetadata} from './accessControlReviewMetadata';
import {reviewAccessSubject} from './accessControlReviewPolicy';
/** Bounded live tenant metadata review; never executes as a reviewed subject. */
export async function reviewAccessControl(ctx:ControlTx,value:unknown){
 const company=ctx.principal.companyId,input=parseAccessReviewInput(value,company);
 const metadata=await readAccessReviewMetadata(ctx,input);
 const items=metadata.subjects.slice(0,input.limit).map(row=>reviewAccessSubject(row,metadata.evaluatedAt,input.dormantDays));
 const findingCountsForPage:Record<string,number>={};
 for(const item of items)for(const finding of item.findings)findingCountsForPage[finding]=(findingCountsForPage[finding]??0)+1;
 return{kind:input.kind,evaluatedAt:metadata.evaluatedAt,populationTotal:metadata.populationTotal,returnedCount:items.length,items,
  nextCursor:metadata.subjects.length>input.limit?accessReviewCursor(company,input.kind,input.dormantDays,items.at(-1)!.id):null,
  findingCountsForPage,coverage:{mode:'live_pagination' as const,census:'same_statement_snapshot' as const,
   subjectAuthority:'descriptive_current_policy' as const,limitations:['Pages may observe later concurrent changes; this is not an immutable export.',
    'Membership rights describe cookie potential; stored grant rights do not attest a live access token.',
    'Never-observed or dormant use metadata is not proof of no use.']}};
}
