/** Types shared by the intercompany connection service, its validation and its routes. */

export type ConnectionKind = 'group' | 'external';
export type ConnectionStatus = 'pending' | 'active' | 'revoked';
export type SettlementMode = 'cash' | 'loan';

/** What a company may set on its own side of a connection. An absent key is unchanged; null clears. */
export interface SideInput {
  customerId?: string | null;
  supplierId?: string | null;
  loanAccountId?: string | null;
  defaultExpenseAccountId?: string | null;
  autoAccept?: boolean;
}

/** The pair's agreement, edited by a user who can write in both companies. An absent key is unchanged; null clears. */
export interface PairInput {
  settlementMode?: SettlementMode;
  cutoverDate?: string | null;
  interestRatePct?: number | null;
}

/** The pair facts every party reads. */
export interface PairSettings {
  settlementMode: SettlementMode;
  cutoverDate: string | null;
  interestRatePct: number | null;
}

/** The parts of a side the setup checklist reads. */
export interface SideState {
  customerId: string | null;
  supplierId: string | null;
  loanAccountId: string | null;
}

export type ChecklistKey = 'customer' | 'supplier' | 'loanAccount' | 'cutover';

export interface ChecklistItem {
  key: ChecklistKey;
  label: string;
  /** False for the loan account while the pair settles in cash. */
  required: boolean;
  done: boolean;
}

export interface Checklist {
  items: ChecklistItem[];
  /** Every required item is done. */
  complete: boolean;
}

export interface NamedRef { id: string; label: string }

/** This company's own side, as the page shows it. */
export interface OwnSide extends SideState {
  autoAccept: boolean;
  defaultExpenseAccountId: string | null;
  customer: NamedRef | null;
  supplier: NamedRef | null;
  loanAccount: NamedRef | null;
  defaultExpenseAccount: NamedRef | null;
}

export interface ConnectionView {
  id: string;
  kind: ConnectionKind;
  status: ConnectionStatus;
  partnerCompanyId: string;
  partnerName: string;
  invitedByCompanyId: string;
  createdAt: string;
  revokedAt: string | null;
  /** The pair's agreement: the same for both companies. */
  settings: PairSettings;
  /** True when the session user can write in BOTH companies, which is what changing `settings` needs. */
  canEditSettings: boolean;
  /** Null until this company first saves its side. */
  side: OwnSide | null;
  checklist: Checklist;
}

export interface GroupCandidate {
  companyId: string;
  companyName: string;
  groupName: string;
  /** The status of the latest connection with this company, or null when there is none. */
  connectionStatus: ConnectionStatus | null;
}

/** What the side form offers to pick from: this company's own customers, suppliers and postable accounts. */
export interface SideOptions {
  customers: NamedRef[];
  suppliers: NamedRef[];
  accounts: NamedRef[];
  /** True when a list was cut at its limit: the person is told, not left to wonder where a name went. */
  truncated: boolean;
}

/** A refusal the route answers with its status: nothing was written. */
export class ConnectionRefusal extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409, message: string) {
    super(message);
    this.name = 'ConnectionRefusal';
  }
}
