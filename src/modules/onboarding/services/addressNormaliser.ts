/**
 * South African address component normaliser.
 *
 * Rescue layer for VLM extractions that dump multi-component addresses into
 * a single line (e.g. "Park West Bloemfontein 9301" stuffed into addressLine2
 * while city/postalCode/province come back empty).
 *
 * - Extracts the 4-digit postal code
 * - Splits the preceding token(s) into suburb + city
 * - Infers province from the postal code range (SAPO block allocation)
 */

export interface AddressFields {
  addressLine1: string;
  addressLine2: string;
  city: string;
  province: string;
  postalCode: string;
}

type Province =
  | 'Eastern Cape'
  | 'Free State'
  | 'Gauteng'
  | 'KwaZulu-Natal'
  | 'Limpopo'
  | 'Mpumalanga'
  | 'North West'
  | 'Northern Cape'
  | 'Western Cape';

/**
 * Infer SA province from a 4-digit postal code using SAPO block allocations.
 * Returns empty string for codes outside the mapped ranges.
 *
 * Source: South African Post Office postal code zones.
 * These are best-effort ranges — a user can always override in the form.
 */
export function inferProvinceFromPostalCode(postalCode: string): Province | '' {
  // Valid SA postal codes are exactly 4 digits, 0001–9999. Empty/non-numeric
  // input must not fall through to the "<= 299" branch via `Number('') === 0`.
  if (!/^\d{4}$/.test(postalCode)) return '';
  const n = Number(postalCode);
  if (n < 1) return '';

  // Gauteng (Pretoria + Johannesburg)
  if (n <= 299)                 return 'Gauteng';         // 0001-0299 Pretoria central
  if (n >= 1400 && n <= 2199)   return 'Gauteng';         // Johannesburg ring
  // North West
  if (n >= 300 && n <= 399)     return 'North West';
  if (n >= 2500 && n <= 2899)   return 'North West';
  // Limpopo
  if (n >= 500 && n <= 999)     return 'Limpopo';
  if (n >= 700 && n <= 799)     return 'Limpopo';
  // Mpumalanga
  if (n >= 1000 && n <= 1399)   return 'Mpumalanga';
  if (n >= 2200 && n <= 2499)   return 'Mpumalanga';
  // KwaZulu-Natal
  if (n >= 2900 && n <= 4730)   return 'KwaZulu-Natal';
  // Eastern Cape
  if (n >= 4731 && n <= 6499)   return 'Eastern Cape';
  // Western Cape (Cape Town + surrounds)
  if (n >= 6500 && n <= 8099)   return 'Western Cape';
  // Northern Cape
  if (n >= 8100 && n <= 8999)   return 'Northern Cape';
  // Free State (Bloemfontein block)
  if (n >= 9000 && n <= 9999)   return 'Free State';

  return '';
}

/**
 * Try to find a 4-digit SA postal code in the input and split it out along
 * with the preceding token(s) as the city. Returns null if no postal code
 * can be confidently extracted.
 *
 * Handles both space-separated ("Park West Bloemfontein 9301") and
 * comma-separated ("Park West, Bloemfontein, 9301") dumps by tokenising on
 * commas first, then falling back to whitespace within the last segment.
 */
function extractPostalAndCity(raw: string): { prefix: string; city: string; postalCode: string } | null {
  if (!raw) return null;

  const codeMatch = raw.match(/\b(\d{4})\b/);
  if (!codeMatch) return null;
  const postalCode = codeMatch[1]!;
  const codeIndex = codeMatch.index ?? 0;

  // Slice out the postal code and strip adjacent separators.
  const beforeCode = raw.slice(0, codeIndex).replace(/[,\s]+$/, '');
  // (Anything after the postal code — country name, etc. — is dropped.)

  // Split the pre-code block on commas first, then on whitespace within the
  // last comma-segment. Take the very last word as the city candidate.
  const segments = beforeCode.split(/\s*,\s*/).map(s => s.trim()).filter(Boolean);
  if (segments.length === 0) {
    return { prefix: '', city: '', postalCode };
  }

  const lastSegment = segments[segments.length - 1]!;
  const lastTokens = lastSegment.split(/\s+/);
  const city = lastTokens[lastTokens.length - 1] ?? '';
  const leftoverTokens = lastTokens.slice(0, -1).join(' ').trim();

  const prefixParts = [
    ...segments.slice(0, -1),
    ...(leftoverTokens ? [leftoverTokens] : []),
  ];
  const prefix = prefixParts.join(', ');

  return { prefix, city, postalCode };
}

/**
 * Normalise address fields, rescuing components that the VLM lumped into a
 * single line. Mutating nothing: returns a new object.
 *
 * Precedence rules:
 * - If `city` AND `postalCode` are both already set, the fields are returned
 *   untouched (trusts the VLM when it did the right thing).
 * - Otherwise tries to rescue from addressLine2, then addressLine1.
 * - Province is filled in from the postal code only if empty.
 */
export function normaliseAddressFields(input: AddressFields): AddressFields {
  // Start with trimmed copies so we never emit stray whitespace.
  const out: AddressFields = {
    addressLine1: input.addressLine1.trim(),
    addressLine2: input.addressLine2.trim(),
    city:         input.city.trim(),
    province:     input.province.trim(),
    postalCode:   input.postalCode.trim(),
  };

  if (out.city && out.postalCode) {
    // VLM did its job — only backfill province if missing.
    if (!out.province) {
      const inferred = inferProvinceFromPostalCode(out.postalCode);
      if (inferred) out.province = inferred;
    }
    return out;
  }

  // Try rescue from line 2 first (more common stuffing target), then line 1.
  for (const key of ['addressLine2', 'addressLine1'] as const) {
    const line = out[key];
    if (!line) continue;
    const rescued = extractPostalAndCity(line);
    if (!rescued) continue;

    // Only overwrite empty destination fields.
    if (!out.postalCode) out.postalCode = rescued.postalCode;
    if (!out.city && rescued.city) out.city = rescued.city;

    // Replace the source line with what's left (the suburb/area prefix).
    out[key] = rescued.prefix;

    // Stop once we've found what we need.
    if (out.city && out.postalCode) break;
  }

  // Province inference from the final postal code.
  if (!out.province && out.postalCode) {
    const inferred = inferProvinceFromPostalCode(out.postalCode);
    if (inferred) out.province = inferred;
  }

  return out;
}
