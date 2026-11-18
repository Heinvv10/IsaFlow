/**
 * Group Company Service — Facade
 * Re-exports from groupCrudService, groupCoaMappingService, and intercompanyService
 * for backward compatibility.
 */

export type { CompanyGroup, GroupMember } from './groupCrudService';
export {
  listGroups,
  listGroupsForUser,
  getGroup,
  createGroup,
  updateGroup,
  deleteGroup,
  addMember,
  findMember,
  updateMember,
  removeMember,
  getGroupMembers,
  mapGroup,
  mapMember,
} from './groupCrudService';

export type { GroupAccount, CoaMapping } from './groupCoaMappingService';
export {
  getGroupAccounts,
  createGroupAccount,
  updateGroupAccount,
  deleteGroupAccount,
  autoGenerateGroupCOA,
  getCoaMappings,
  setCoaMapping,
  removeCoaMapping,
  autoMapAccounts,
  getUnmappedAccounts,
  mapGroupAccount,
  mapCoaMapping,
} from './groupCoaMappingService';

export type {
  IntercompanyTransaction,
  IntercompanyReconciliation,
  IntercompanyFilters,
} from './intercompanyService';
export {
  listIntercompanyTransactions,
  createIntercompanyTransaction,
  matchIntercompanyTransactions,
  getTransactionParties,
  getIntercompanyReconciliation,
  mapIntercompanyTx,
} from './intercompanyService';
