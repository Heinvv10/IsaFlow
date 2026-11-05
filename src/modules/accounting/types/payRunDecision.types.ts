/** What the run API tells a client about who approved a pay run: no ids, only the two facts a page shows. */
export interface PayRunDecisionSummary {
  /** The decider is the requester: approved through the sole-approver fallback (nobody else could approve). */
  selfApprovedSoleApprover: boolean;
  /** The person who last calculated the run also decided its approval. */
  preparedByDecider: boolean;
}
