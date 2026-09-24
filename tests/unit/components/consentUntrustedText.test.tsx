/**
 * Nothing an attacker puts in a URL may become copy on an ISAFlow-branded page.
 *
 * Two distinct surfaces, one class:
 *
 * 1. The rejection screen (#480). `getServerSideProps` interpolated the
 *    offending scope into `Unknown scope: ${s}`, and ConsentRejected renders
 *    that under the heading "Authorisation request rejected" inside our own
 *    panel. React escapes it, so this was never XSS — it is content injection:
 *    a crafted link puts attacker-chosen words where a reader expects ours.
 *
 * 2. The company picker (#483). The app's own name was interpolated into a
 *    sentence WE wrote — "{appName} will only ever see this company." A name
 *    that ends the sentence early makes our reassurance say something we did
 *    not say. Position, not content, so the reserved-name matcher cannot
 *    catch it however many terms it grows.
 *
 * Both are fixed by removing the interpolation, not by guarding it.
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConsentCompanyPicker } from '@/components/oauth/ConsentCompanyPicker';

const COMPANIES = [
  { id: 'c1', name: 'Acme (Pty) Ltd' },
  { id: 'c2', name: 'Beta (Pty) Ltd' },
];

describe('ConsentCompanyPicker — the guarantee is our sentence alone', () => {
  // Two companies, so the <select> branch with the reassurance line renders.
  const render = () =>
    renderToStaticMarkup(
      React.createElement(ConsentCompanyPicker, {
        companies: COMPANIES,
        value: 'c1',
        onChange: () => {},
        disabled: false,
      }),
    );

  it('states the guarantee as a constant, naming no app', () => {
    expect(render()).toContain('This app will only ever see this company.');
  });

  // Scope, so nobody credits this with more than it does: the component no
  // longer HAS an appName prop, so a test that passes attack text would be
  // asserting on a no-op and could never go red. What actually keeps the class
  // out is the prop's absence — re-adding the interpolation means re-adding a
  // prop and a call-site argument, and `pages/` IS inside tsconfig, so tsc
  // catches a mismatch there. This test pins the copy, nothing more.
  it('renders the same sentence regardless of which companies are shown', () => {
    const other = renderToStaticMarkup(
      React.createElement(ConsentCompanyPicker, {
        companies: [{ id: 'z', name: 'Zeta' }, { id: 'y', name: 'Yankee' }],
        value: 'z',
        onChange: () => {},
        disabled: true,
      }),
    );
    expect(other).toContain('This app will only ever see this company.');
  });
});
