/**
 * User Switcher Extension Configuration
 */

const isProd = process.env.NODE_ENV === 'production';
const masterPassword = process.env.MASTER_USER_PASSWORD;

if (isProd && !masterPassword) {
  console.error('[USER-SWITCHER CRITICAL ERROR] ❌ MASTER_USER_PASSWORD must be defined in environment variables for production! Default fallback disabled.');
}

module.exports = {
  // Master user credentials (auto-created on startup if not present)
  masterUser: {
    username: process.env.MASTER_USER_NAME || 'masteradmin',
    email: (process.env.MASTER_USER_EMAIL || 'master@mybill.com').toLowerCase(),
    password: masterPassword || (isProd ? null : 'Master@123456'),
    role: 'superadmin',
  },

  // List of emails that are granted Master User status
  allowedMasterEmails: [
    (process.env.MASTER_USER_EMAIL || 'master@mybill.com').toLowerCase(),
  ],

  // Whether existing superadmins in User collection are permitted to switch users (strictly false: MasterUser only)
  allowSuperAdminToSwitch: false,

  // Direct master session token validity
  tokenExpiry: process.env.MASTER_TOKEN_EXPIRY || '7d',

  // Switched impersonation session token validity (short TTL for security)
  switchedTokenExpiry: process.env.SWITCHED_TOKEN_EXPIRY || '4h',

  // Rate limiting for master authentication: max attempts per window
  rateLimit: {
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10, // max 10 attempts per 15 minutes
  },
};
