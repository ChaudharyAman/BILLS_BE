/**
 * jest.config.js
 *
 * Configuration for Jest test runner in MBB.
 */

module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  testTimeout: 30000,
  verbose: true,
  clearMocks: true,
};
