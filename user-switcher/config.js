/**
 * User Switcher Extension Configuration
 */

const masterPassword = process.env.MASTER_USER_PASSWORD ? process.env.MASTER_USER_PASSWORD.trim() : null;

/**
 * Validates if the master password meets strict security standards:
 * - Minimum 12 characters long
 * - Contains uppercase, lowercase, numeric, and special characters
 * - Not a known default or trivial password
 */
function isStrongMasterPassword(pw) {
  if (!pw || typeof pw !== 'string') return false;
  if (pw.length < 12) return false;
  if (['Master@123456', 'password', 'password123', 'admin', 'admin123', 'masteradmin'].includes(pw)) return false;
  const hasUpper = /[A-Z]/.test(pw);
  const hasLower = /[a-z]/.test(pw);
  const hasNumber = /[0-9]/.test(pw);
  const hasSpecial = /[^A-Za-z0-9]/.test(pw);
  return hasUpper && hasLower && hasNumber && hasSpecial;
}

if (!masterPassword) {
  console.error('[USER-SWITCHER CRITICAL ERROR] ❌ MASTER_USER_PASSWORD is missing! Master user will NOT be enabled in any environment.');
} else if (!isStrongMasterPassword(masterPassword)) {
  console.error('[USER-SWITCHER CRITICAL ERROR] ❌ MASTER_USER_PASSWORD is too weak! Must be at least 12 characters and contain uppercase, lowercase, numbers, and symbols. Master user disabled.');
}

module.exports = {
  // Master user credentials (NO default password fallback - strictly requires valid env variable)
  masterUser: {
    username: process.env.MASTER_USER_NAME || 'masteradmin',
    email: (process.env.MASTER_USER_EMAIL || 'master@mybill.com').toLowerCase(),
    password: masterPassword,
    role: 'superadmin',
  },

  isStrongMasterPassword,

  // List of emails that are granted Master User status
  allowedMasterEmails: [
    (process.env.MASTER_USER_EMAIL || 'master@mybill.com').toLowerCase(),
  ],

  // Whether existing superadmins in User collection are permitted to switch users (strictly false: MasterUser only)
  allowSuperAdminToSwitch: false,

  // Direct master session token validity
  tokenExpiry: process.env.MASTER_TOKEN_EXPIRY || '12h',

  // Switched impersonation session token validity (short TTL for security)
  switchedTokenExpiry: process.env.SWITCHED_TOKEN_EXPIRY || '2h',

  // Rate limiting for master authentication: max attempts per window
  rateLimit: {
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10, // max 10 attempts per 15 minutes
  },
};
