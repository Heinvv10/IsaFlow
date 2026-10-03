/**
 * The legal entity that owns and operates IsaFlow.
 *
 * "IsaFlow" is a trading name, not a legal person. The privacy policy (the
 * responsible party, POPIA s1) and the Terms (the contracting party) must name
 * this entity, and ECTA s43(1) requires these details on the website.
 * Source: CIPC disclosure for registration number 2005/023519/07.
 */
export const LEGAL_ENTITY = {
  name: 'Brightsphere Technologies (Pty) Ltd',
  registrationNumber: '2005/023519/07',
  tradingName: 'IsaFlow',
  legalStatus: 'Private company incorporated in South Africa',
  registeredAddress:
    '7 Burchel Close, Natures Valley, Somerset West, Western Cape, 7130, South Africa',
  director: 'Jan Hendrik van Vuuren',
  informationOfficer: 'Jan Hendrik van Vuuren',
  contactEmail: 'accounts@isaflow.co.za',
  website: 'https://www.isaflow.co.za',
} as const;

/** Date of the current revision of the public legal pages. */
export const LEGAL_LAST_UPDATED = '2 October 2026';
