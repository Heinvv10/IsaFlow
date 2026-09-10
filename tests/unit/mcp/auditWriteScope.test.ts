import {expect,it} from 'vitest';
import {MCP_TOOLS} from '@/lib/mcp/toolIndex';
import {SCOPE_LABELS} from '@/lib/auth/consentScopeLabels';
import {PAT_SCOPE_META} from '@/lib/auth/patScopeMeta';
import {AUDIT_ENQUEUE_QUOTAS} from '@/modules/accounting/services/controls/auditEnqueueQuota';
/**
 * `write:audit` is what a person consents to when they let an agent START forensic work. The tools that enqueue that
 * work must be exactly the ones gated on it, the reads must stay on read:reports, and the consent copy must describe
 * every kind of job the scope actually starts — a label that promises less than is enforced is false consent.
 */
const ENQUEUE=['audit_snapshot','compare_audit_snapshots','export_audit_evidence','run_control_checks'];
it('gates every audit enqueue on write:audit and nothing else on it',()=>{
 expect(MCP_TOOLS.filter(tool=>tool.scope==='write:audit').map(tool=>tool.name).sort()).toEqual(ENQUEUE);
 for(const name of ['audit_job_status','audit_snapshot_manifest','audit_snapshot_items','audit_snapshot_chunk','audit_export_files','audit_export_chunk',
  'audit_comparison_items','control_check_run','control_check_run_findings'])
  expect(MCP_TOOLS.find(tool=>tool.name===name)?.scope,`${name} is a read and must stay on read:reports`).toBe('read:reports');
});
it('describes every kind of job write:audit starts, in both consent surfaces',()=>{
 for(const text of [SCOPE_LABELS['write:audit'],PAT_SCOPE_META['write:audit'].desc])
  for(const kind of [/snapshot/i,/export/i,/compar/i,/check run/i])expect(text,`the write:audit consent copy omits ${kind}`).toMatch(kind);
});
it('sizes a rolling window, a company cap and a per-member share for every audit job kind',()=>{
 // Pinned: whether to tighten these is Hein's decision with the measured storage rate in front of him (plan v10).
 expect(AUDIT_ENQUEUE_QUOTAS).toEqual({
  audit_snapshot:{windowHours:24,perCompany:50,perPrincipal:20},audit_export:{windowHours:24,perCompany:50,perPrincipal:20},
  audit_compare:{windowHours:24,perCompany:100,perPrincipal:40},audit_check_run:{windowHours:24,perCompany:100,perPrincipal:40}});
 for(const quota of Object.values(AUDIT_ENQUEUE_QUOTAS))expect(quota.perPrincipal,'one member could spend the whole company window').toBeLessThan(quota.perCompany);
});
