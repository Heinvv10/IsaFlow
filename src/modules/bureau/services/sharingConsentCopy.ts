/**
 * POPIA consent wording shown beside the bureau's "share merchant patterns" switch.
 *
 * DRAFT [VERIFY] — pending legal review. Not approved wording: the UI shows SHARING_CONSENT_STATUS_LABEL
 * beside it until legal signs it off. One constant so the page, any email and PR 2's pool all quote the same
 * text. No compliance claims and no customer names, on purpose.
 *
 * Tense: nothing pools yet (PR 2), so the copy says what WILL happen when pooling is available.
 *
 * FOR LEGAL REVIEW (Hein): "never shared … the names of individuals" is a promise PR 2 cannot fully keep from
 * bank descriptions alone. Many merchants that appear at 5+ companies are sole proprietors trading under
 * their own name ("J SMITH PLUMBING"), and a business name can be a person's name. Either PR 2 defines a
 * filter and this softens to "we remove the names of individuals we can detect", or legal accepts the risk
 * as worded. Decide before this ships out of DRAFT.
 */

export const SHARING_CONSENT_STATUS = 'DRAFT [VERIFY]' as const;
export const SHARING_CONSENT_STATUS_LABEL = 'Draft wording, pending legal review';

export const SHARING_CONSENT_COPY = {
  title: 'Share merchant patterns to improve suggestions',
  intro:
    'When pooled suggestions are available, and while this is on, ISAFlow will use how your clients code their '
    + 'bank lines to suggest categories to other ISAFlow users, and you will get suggestions built from theirs. '
    + 'Nothing is pooled yet.',
  sharedHeading: 'What is shared',
  shared: [
    'Only merchant or business names (for example, a fuel company or a phone network) that appear at 5 or more '
      + 'ISAFlow client companies, together with the category they are usually coded to.',
    'The pool will be built from your clients’ past and future coding.',
  ],
  neverSharedHeading: 'What is never shared',
  neverShared: [
    'Company names, amounts, bank account numbers, payment references or the names of individuals.',
    'Anything that links a pattern back to you or to any of your clients.',
  ],
  controlsHeading: 'Your choice',
  controls: [
    'This is off unless the bureau owner switches it on.',
    'You can switch it off at any time. From then on, your clients’ coding will not be used in future pool updates.',
    'Pooled suggestions will only be suggestions. ISAFlow will never post them automatically.',
    'Clients that are not linked to a bureau are not included.',
  ],
} as const;
