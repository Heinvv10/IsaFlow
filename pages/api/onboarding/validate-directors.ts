/**
 * POST /api/onboarding/validate-directors
 * Cross-references user-entered directors against CIPC-extracted directors.
 * Returns validation results: matches, mismatches, missing from CIPC, extra not on CIPC.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth } from '@/lib/auth';

interface DirectorInput {
  name: string;
  idNumber: string;
  role: string;
}

interface ValidationResult {
  status: 'valid' | 'warnings';
  matches: { entered: string; cipc: string; field: string }[];
  warnings: { type: 'missing_from_entry' | 'not_on_cipc' | 'id_mismatch' | 'name_mismatch'; message: string }[];
}

/** Normalize name for comparison: lowercase, trim, collapse spaces, strip titles */
function normName(n: string): string {
  return n
    .toLowerCase()
    .replace(/\b(mr|mrs|ms|dr|prof|adv)\.?\s*/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Check if two names are similar enough (one contains the other, or share surname) */
function namesMatch(a: string, b: string): boolean {
  const na = normName(a);
  const nb = normName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // Check if one contains the other (handles middle name differences)
  if (na.includes(nb) || nb.includes(na)) return true;
  // Check if surnames match (last word)
  const surnameA = na.split(' ').pop() ?? '';
  const surnameB = nb.split(' ').pop() ?? '';
  if (surnameA.length > 2 && surnameA === surnameB) return true;
  return false;
}

/** Normalize ID number: strip spaces and dashes */
function normId(id: string): string {
  return id.replace(/[\s-]/g, '').trim();
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method!, ['POST']);
  }

  const { enteredDirectors, cipcDirectors } = req.body as {
    enteredDirectors?: DirectorInput[];
    cipcDirectors?: DirectorInput[];
  };

  if (!Array.isArray(enteredDirectors) || !Array.isArray(cipcDirectors)) {
    return apiResponse.badRequest(res, 'enteredDirectors and cipcDirectors arrays are required');
  }

  const result: ValidationResult = { status: 'valid', matches: [], warnings: [] };

  // If no CIPC directors were extracted, we can't validate
  if (cipcDirectors.length === 0) {
    result.warnings.push({
      type: 'missing_from_entry',
      message: 'No directors were found on the CIPC certificate. Validation skipped.',
    });
    return apiResponse.success(res, result);
  }

  const matchedCipc = new Set<number>();
  const matchedEntered = new Set<number>();

  // Match entered directors against CIPC directors
  for (let ei = 0; ei < enteredDirectors.length; ei++) {
    const entered = enteredDirectors[ei]!;
    for (let ci = 0; ci < cipcDirectors.length; ci++) {
      if (matchedCipc.has(ci)) continue;
      const cipc = cipcDirectors[ci]!;

      if (namesMatch(entered.name, cipc.name)) {
        matchedEntered.add(ei);
        matchedCipc.add(ci);
        result.matches.push({ entered: entered.name, cipc: cipc.name, field: 'name' });

        // Check ID number match if both provided
        if (normId(entered.idNumber) && normId(cipc.idNumber)) {
          if (normId(entered.idNumber) !== normId(cipc.idNumber)) {
            result.warnings.push({
              type: 'id_mismatch',
              message: `ID number mismatch for ${entered.name}: entered "${entered.idNumber}" vs CIPC "${cipc.idNumber}"`,
            });
          }
        }
        break;
      }
    }
  }

  // Directors on CIPC but not entered
  for (let ci = 0; ci < cipcDirectors.length; ci++) {
    if (!matchedCipc.has(ci)) {
      result.warnings.push({
        type: 'missing_from_entry',
        message: `${cipcDirectors[ci]!.name} is listed on the CIPC certificate but not added as a director.`,
      });
    }
  }

  // Directors entered but not on CIPC
  for (let ei = 0; ei < enteredDirectors.length; ei++) {
    if (!matchedEntered.has(ei)) {
      result.warnings.push({
        type: 'not_on_cipc',
        message: `${enteredDirectors[ei]!.name} is not found on the CIPC certificate.`,
      });
    }
  }

  result.status = result.warnings.length > 0 ? 'warnings' : 'valid';
  return apiResponse.success(res, result);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withAuth(withErrorHandler(handler));
