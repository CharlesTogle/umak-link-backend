import crypto from 'node:crypto';

const CLAIM_CODE_LENGTH = 6;
const CLAIM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function normalizeClaimCodeInput(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CLAIM_CODE_LENGTH);
}

export function generateClaimCode(): string {
  const randomBytes = crypto.randomBytes(CLAIM_CODE_LENGTH);

  return Array.from(
    randomBytes,
    (value) => CLAIM_CODE_ALPHABET[value % CLAIM_CODE_ALPHABET.length]
  ).join('');
}
