import '@testing-library/jest-dom';
import { configure } from '@testing-library/react';

// findBy* / waitFor give up after 1 s by default. Under a loaded machine (the pre-push gate runs every suite at once,
// next to other repos' runners) a render that takes longer failed tests that pass alone — several files already set
// this one by one. Every component file gets it here.
configure({ asyncUtilTimeout: 4000 });
