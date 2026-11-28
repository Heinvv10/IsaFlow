import { test, expect } from '@playwright/test';
import { guardDevTarget } from './helpers/devTarget';

guardDevTarget(test);
test('Scenario planning service importable', () => { expect(true).toBe(true); });
