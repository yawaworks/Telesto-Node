import { authenticator } from "otplib";
import crypto from "crypto";
import bcrypt from "bcryptjs";

authenticator.options = { window: 1 }; // accept ±1 time-step (±30s) for clock drift

const APP_NAME = "Telesto Node";

/** Generates a new random TOTP secret and the otpauth:// URL used to
 * build a QR code for it. Not yet enabled — the caller must verify a
 * code against this secret before persisting it as the user's active
 * twoFactorSecret. */
export function generateTwoFactorSecret(userEmail) {
  const secret = authenticator.generateSecret();
  const otpauthUrl = authenticator.keyuri(userEmail, APP_NAME, secret);
  return { secret, otpauthUrl };
}

/** Verifies a 6-digit TOTP code against a secret. */
export function verifyTotpToken(secret, token) {
  if (!secret || !token) return false;
  try {
    return authenticator.check(String(token).trim(), secret);
  } catch {
    return false;
  }
}

/** Generates a set of one-time backup codes (shown once at 2FA setup),
 * plus their bcrypt hashes for storage — same "never store the plaintext"
 * principle as passwords. A backup code is consumed (removed from the
 * hash list) the moment it's used, so each one only works once. */
export async function generateBackupCodes(count = 8) {
  const plainCodes = Array.from({ length: count }, () =>
    crypto.randomBytes(5).toString("hex") // 10 hex chars, e.g. "a1b2c3d4e5"
  );
  const hashedCodes = await Promise.all(
    plainCodes.map((code) => bcrypt.hash(code, 10))
  );
  return { plainCodes, hashedCodes };
}

/** Checks a candidate backup code against the stored hashes, returning
 * the index of the matching hash (to remove it) or -1 if none match. */
export async function findMatchingBackupCodeIndex(candidateCode, hashedCodes) {
  if (!candidateCode || !Array.isArray(hashedCodes)) return -1;
  const normalized = String(candidateCode).trim().toLowerCase();
  for (let i = 0; i < hashedCodes.length; i++) {
    if (await bcrypt.compare(normalized, hashedCodes[i])) return i;
  }
  return -1;
}