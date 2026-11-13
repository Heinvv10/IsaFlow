import { vi } from 'vitest';
import '@testing-library/jest-dom';
import { configure } from '@testing-library/react';

// findBy* / waitFor give up after 1 s by default. Under a loaded machine (the pre-push gate runs every suite at once,
// next to other repos' runners) a render that takes longer failed tests that pass alone — several files already set
// this one by one. Every component file gets it here.
configure({ asyncUtilTimeout: 4000 });

// M14: CommentsPanel reads the auth and company contexts and fetches its own thread. The many suites that render an
// invoice drawer, a bill page or a bank line drawer under their own apiFetch mocks (and count its calls) do not
// provide those, so it renders nothing here. commentsPanel.test.tsx un-mocks it and tests the real one.
vi.mock('@/components/accounting/comments/CommentsPanel', () => ({ CommentsPanel: () => null }));
