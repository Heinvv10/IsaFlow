import {createHash} from 'node:crypto';
import Decimal from 'decimal.js';
import {isRealCalendarDate} from '@/lib/validation';
import {canonicalJson,canonicalMoney} from './canonical';
import type {ControlCheckResult,ControlFinding,EntityVersionRef} from './contracts';
export interface RiskCheckOptions {cursor?:string;limit?:number;cutoff?:string}
export interface RiskFinding {finding:ControlFinding;amount:string;currency:string}
export const RISK_SOURCE_LIMIT=10000;
export const riskHash=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
export function riskOptions(input:RiskCheckOptions){
 const limit=input.limit??20;
 if(!Number.isSafeInteger(limit)||limit<1||limit>100||Object.keys(input).some(k=>!['cursor','limit','cutoff'].includes(k)))throw new Error('Invalid risk-check options');
 if(input.cutoff!==undefined&&(!isRealCalendarDate(input.cutoff)||!/^\d{4}-\d{2}-\d{2}$/.test(input.cutoff)))throw new Error('Invalid reporting cutoff');
 if(input.cursor!==undefined&&(typeof input.cursor!=='string'||input.cursor.length>1024))throw new Error('Invalid risk cursor');
 return{...input,limit,cutoff:input.cutoff??null};
}
export function riskResult(input:{companyId:string;id:string;options:RiskCheckOptions;populationCount:number;excludedCount:number;findings:RiskFinding[];
 missing:string[];coverage:string[];capturedAt:string;sourceVersions:EntityVersionRef[];sourceHash:string}):ControlCheckResult{
 const options=riskOptions(input.options),findings=[...input.findings].sort((a,b)=>a.finding.key<b.finding.key?-1:a.finding.key>b.finding.key?1:0);
 const signature=riskHash({companyId:input.companyId,check:input.id,cutoff:options.cutoff,source:input.sourceHash});let offset=0;
 if(options.cursor){
  try{const cursor=JSON.parse(Buffer.from(options.cursor,'base64url').toString('utf8')) as {offset:number;signature:string};
   if(!Number.isSafeInteger(cursor.offset)||cursor.offset<0||cursor.offset>findings.length||cursor.signature!==signature)throw new Error('changed');offset=cursor.offset;
  }catch{throw new Error('Risk population changed or cursor invalid; restart the check');}
 }
 const D=Decimal.clone({precision:80}),totals:Record<string,string>={};
 for(const finding of findings){if(!/^[A-Z]{3}$/.test(finding.currency))continue;totals[finding.currency]=new D(totals[finding.currency]??'0').add(canonicalMoney(finding.amount)).toFixed();}
 const missing=[...new Set(input.missing)].sort(),next=offset+options.limit;
 return{checkId:input.id,checkVersion:1,status:findings.length?'fail':missing.length?'unknown':'pass',populationCount:input.populationCount,
 excludedCount:input.excludedCount,findingCount:findings.length,amountTotals:totals,findings:findings.slice(offset,next).map(row=>row.finding),
 nextCursor:next<findings.length?Buffer.from(JSON.stringify({offset:next,signature})).toString('base64url'):null,
 coverage:input.coverage,missingSources:missing,capturedAt:input.capturedAt,cutoff:options.cutoff,sourceVersions:input.sourceVersions};
}
