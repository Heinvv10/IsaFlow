/** Contact checks for the onboarding address step: an empty value is fine (the step is skippable), a filled one must parse. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_CHARS = /^\+?[\d\s()-]+$/;

export function emailError(v: string): string {
  const t = v.trim();
  return t === '' || EMAIL.test(t) ? '' : 'Enter a valid email address, like name@company.co.za';
}

export function phoneError(v: string): string {
  const t = v.trim();
  if (t === '') return '';
  const digits = t.replace(/\D/g, '');
  return PHONE_CHARS.test(t) && digits.length >= 7 && digits.length <= 15 ? '' : 'Enter a valid phone number, like 082 123 4567';
}

export function contactIssues(d: { email: string; phone: string }): string[] {
  return [phoneError(d.phone), emailError(d.email)].filter(Boolean);
}
