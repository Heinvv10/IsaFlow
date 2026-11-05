/**
 * Request shapes shared by the budget controls routes and the controls page (pure: zod only).
 * A threshold list: 1-5 whole percentages in 1-999 (the table allows more; the API keeps it small).
 */
import { z } from 'zod';
import { MAX_THRESHOLDS, THRESHOLD_MAX, THRESHOLD_MIN } from './overspendAlertsCore';

export const ThresholdsSchema = z.array(z.number().int().min(THRESHOLD_MIN).max(THRESHOLD_MAX))
  .min(1).max(MAX_THRESHOLDS);
