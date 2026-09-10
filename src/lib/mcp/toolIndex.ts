import {forensicExceptionTools} from './tools/forensicExceptions';
import {connectionPermissionsTool,accessControlReviewTool} from './tools/forensicAccess';
import {forensicHistoryTools} from './tools/forensicHistory';
import {operationalCheckTools} from './tools/forensicOperationalChecks';
import {forensicApprovalTools} from './tools/forensicApprovals';
import {forensicBeneficiaryTools} from './tools/forensicBeneficiaries';
import {bankPreparedOperationTools} from './tools/bankPreparedOperations';
import {McpRegistry} from './registry';
import {EXISTING_MCP_TOOLS} from './existingTools';
import {auditDeliveryTools} from './tools/auditDelivery';
import {auditCheckRunTools} from './tools/auditCheckRuns';
/** One authoritative composition for transport, discovery and contract verification. */
export const MCP_TOOLS=[...EXISTING_MCP_TOOLS,...auditDeliveryTools,...auditCheckRunTools,...forensicApprovalTools,...forensicBeneficiaryTools,...bankPreparedOperationTools,...operationalCheckTools,...forensicHistoryTools,connectionPermissionsTool,accessControlReviewTool,...forensicExceptionTools] as const;
export const mcpRegistry=new McpRegistry();
for(const tool of MCP_TOOLS)mcpRegistry.register(tool);
