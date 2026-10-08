/**
 * The approver-role picker for a rule (R-035 follow-up, PR A). Offers only the
 * roles the actor may demand — demandableApproverRoles, the predicate
 * assertMayDemand refuses by — strictest first. A value above the actor (an
 * existing rule's role, or a recommended rule's) is still shown, as an option
 * that cannot be chosen, so the field never silently reads as a lower role.
 * The server stays authoritative and its refusal is shown where this is used.
 */
import { demandableApproverRoles } from '@/modules/accounting/services/gl/approvalRank';

interface Props {
  actorRole: string;
  value: string;
  onChange: (role: string) => void;
  label: string;
  id?: string;
  className?: string;
}

export function ApprovalRoleSelect({ actorRole, value, onChange, label, id, className }: Props) {
  const roles = demandableApproverRoles(actorRole);
  return (
    <select id={id} aria-label={id ? undefined : label} value={value} onChange={(e) => onChange(e.target.value)} className={className}>
      {!roles.includes(value) && <option value={value} disabled>{value} (you cannot choose this role)</option>}
      {roles.map((role) => <option key={role} value={role}>{role}</option>)}
    </select>
  );
}
