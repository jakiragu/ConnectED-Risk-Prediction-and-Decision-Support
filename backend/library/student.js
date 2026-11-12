/**
 * Rules for a student record, shared by the school service and the CSV import
 * in the browser, so both accept exactly the same values.
 */

/** Letters, digits, / and - only; at most 20 characters. Stored exactly as typed. */
export const ADMISSION = /^[A-Za-z0-9/-]{1,20}$/;
export const ADMISSION_MAX = 20;
/** The longest first or last name the service accepts. */
export const NAME_MAX = 60;

/** The longest guardian name the service accepts. */
export const GUARDIAN_NAME_MAX = 60;

/**
 * A guardian's mobile number in international form (+254712345678), or null
 * for an empty value. Kenyan numbers may be typed the local way (0712 345 678,
 * 712345678, 254712345678); any other country's number needs its + and code.
 * Spaces, dashes, dots and brackets are ignored.
 * Throws an Error with a message an administrator can act on.
 */
export function normalisePhone(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (!/^[+\d\s().-]+$/.test(raw)) throw new Error('Phone numbers use digits, spaces and a leading + only');
  const digits = raw.replace(/\D/g, '');
  if (raw.startsWith('+')) {
    if (digits.startsWith('254')) return kenyan(digits.slice(3));
    if (digits.length < 8 || digits.length > 15) throw new Error('That phone number is too short or too long');
    return `+${digits}`;
  }
  if (digits.startsWith('254') && digits.length === 12) return kenyan(digits.slice(3));
  if (digits.startsWith('0') && digits.length === 10) return kenyan(digits.slice(1));
  if (digits.length === 9) return kenyan(digits);
  throw new Error('Enter a mobile number such as 0712 345 678, or +256 712 345 678 for another country');
}

/** The 9 digits after +254: Kenyan mobile numbers start with 7 or 1. */
function kenyan(rest) {
  if (!/^[17]\d{8}$/.test(rest)) throw new Error('That is not a Kenyan mobile number (07… or 01…, 10 digits)');
  return `+254${rest}`;
}

/** +254712345678 → 0712 345 678 for Kenyan numbers; other countries stay in international form. */
export function displayPhone(phone) {
  if (!phone) return '';
  const m = /^\+254(\d{3})(\d{3})(\d{3})$/.exec(phone);
  return m ? `0${m[1]} ${m[2]} ${m[3]}` : phone;
}
