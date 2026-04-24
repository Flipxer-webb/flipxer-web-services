/**
 * Backup Codes Utility
 * 
 * Generates formatted backup codes for 2FA recovery.
 * Format: XXXXX-XXXXX-XXXXX-XXXXX (20-digit alphanumeric with dashes)
 */

import * as crypto from 'node:crypto';
import * as bcrypt from 'bcryptjs';

/**
 * Generate a single backup code in format XXXXX-XXXXX-XXXXX-XXXXX (20 characters)
 * Uses uppercase alphanumeric characters (A-Z, 0-9)
 */
function generateBackupCode(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  
  // Generate 20 random characters
  for (let i = 0; i < 20; i++) {
    const randomIndex = crypto.randomInt(0, chars.length);
    code += chars[randomIndex];
  }
  
  // Format as XXXXX-XXXXX-XXXXX-XXXXX
  return `${code.slice(0, 5)}-${code.slice(5, 10)}-${code.slice(10, 15)}-${code.slice(15, 20)}`;
}

/**
 * Generate multiple backup codes
 * 
 * @param count - Number of codes to generate (default: 5)
 * @returns Array of formatted backup codes
 */
export function generateBackupCodes(count: number = 5): string[] {
  const codes = new Set<string>();
  
  // Ensure uniqueness
  while (codes.size < count) {
    codes.add(generateBackupCode());
  }
  
  return Array.from(codes);
}

/**
 * Hash backup codes for secure storage
 * 
 * @param codes - Plain text backup codes
 * @returns Array of hashed codes
 */
export async function hashBackupCodes(codes: string[]): Promise<string[]> {
  const saltRounds = 10;
  return Promise.all(codes.map(code => bcrypt.hash(code, saltRounds)));
}

/**
 * Verify a backup code against stored hashes
 * 
 * @param code - Plain text backup code to verify
 * @param hashedCodes - Array of hashed backup codes from database
 * @returns Index of matching code if found, -1 otherwise
 */
export async function verifyBackupCode(
  code: string,
  hashedCodes: string[],
): Promise<number> {
  for (let i = 0; i < hashedCodes.length; i++) {
    const isMatch = await bcrypt.compare(code, hashedCodes[i]);
    if (isMatch) {
      return i;
    }
  }
  return -1;
}

/**
 * Remove a used backup code from the hashed codes array
 * 
 * @param hashedCodes - Array of hashed backup codes
 * @param index - Index of code to remove
 * @returns New array without the used code
 */
export function removeUsedBackupCode(
  hashedCodes: string[],
  index: number,
): string[] {
  return hashedCodes.filter((_, i) => i !== index);
}
