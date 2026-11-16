/** The last four digits only, for logs and for output pasted into a public issue. */
export function maskNumber(number: string): string {
  const digits = number.replaceAll(/\D/g, '');
  return digits.length > 4 ? `***${digits.slice(-4)}` : '***';
}

/**
 * Masks every run of six or more digits, with or without a leading `+`: a phone number in
 * any form, or one cut short by a truncated error. Twilio's error codes are five digits.
 */
export function maskNumbers(text: string): string {
  return text.replaceAll(/\+?\d{6,}/g, maskNumber);
}
