/** The rule-write guards a test passes when the guard itself is not what it tests (the services require one: #1656 round 7). */
import type { RuleDeleteGuard, RuleWriteGuard } from '@/modules/accounting/services/bank/bankRuleChangeControl';

export const anyRuleWrite: RuleWriteGuard = () => undefined;
export const anyRuleDelete: RuleDeleteGuard = () => undefined;
