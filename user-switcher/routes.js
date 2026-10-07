const express = require('express');
const router = express.Router();
const controller = require('./controller');
const {
  requireSwitchAccess,
  requireSwitchedSession,
  masterLoginLimiter,
  switchActionLimiter,
  userListLimiter,
} = require('./middleware');

// Public endpoints (rate-limited)
router.post('/login', masterLoginLimiter, controller.login);
router.get('/status', controller.getStatus);

// Exit impersonation session - STRICTLY GUARDED: requires active switched JWT
router.post('/exit', switchActionLimiter, requireSwitchedSession, controller.exitSwitch);

// Protected routes (Master User or Superadmin)
router.get('/users', userListLimiter, requireSwitchAccess, controller.listUsers);
router.post('/switch', switchActionLimiter, requireSwitchAccess, controller.switchUser);

module.exports = router;
