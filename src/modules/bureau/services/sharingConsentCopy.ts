/**
 * POPIA consent wording shown beside the bureau's "share merchant patterns" switch.
 *
 * DRAFT [VERIFY] — pending legal review. Not approved wording: the UI shows SHARING_CONSENT_STATUS_LABEL
 * beside it until legal signs it off. One constant so the page, any email and PR 2's pool all quote the same
 * text. No compliance claims and no customer names, on purpose.
 */

export const SHARING_CONSENT_STATUS = 'DRAFT [VERIFY]' as const;
export const SHARING_CONSENT_STATUS_LABEL = 'Draft wording, pending legal review';

export const SHARING_CONSENT_COPY = {
  title: 'Share merchant patterns to improve suggestions',
  intro:
    'When this is on, ISAFlow uses how your clients code their bank lines to suggest categories to other ISAFlow '
    + 'users, and you get suggestions built from theirs.',
  sharedHeading: 'What is shared',
  shared: [
    'Only merchant or business names (for example, a fuel company or a phone network) that appear at 5 or more '
      + 'ISAFlow client companies, together with the category they are usually coded to.',
    'This is built from your clients’ past and future coding.',
  ],
  neverSharedHeading: 'What is never shared',
  neverShared: [
    'Company names, amounts, bank account numbers, payment references or the names of individuals.',
    'Anything that links a pattern back to you or to any of your clients.',
  ],
  controlsHeading: 'Your choice',
  controls: [
    'This is off unless the bureau owner switches it on.',
    'You can switch it off at any time. From then on, your clients’ coding is not used in future pool updates.',
    'Pooled suggestions are only suggestions. ISAFlow never posts them automatically.',
    'Clients that are not linked to a bureau are not included.',
  ],
} as const;
