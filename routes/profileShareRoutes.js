const express = require('express');
const router = express.Router({ mergeParams: true });
const rateLimit = require('express-rate-limit');
const profileShareController = require('../controllers/profileShareController');
const { protect, authorize } = require('../middleware/authMiddleware');

const shareLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many share access attempts. Please try again after 15 minutes.',
});

// Authenticated management endpoints mounted under /api/profiles/:profileId/shares
router.get('/', protect, authorize('teamMembers', 'view'), profileShareController.getShares);
router.post('/', protect, authorize('teamMembers', 'create'), profileShareController.createShare);
router.patch('/:shareId', protect, authorize('teamMembers', 'edit'), profileShareController.updateShare);
router.post('/:shareId/revoke', protect, authorize('teamMembers', 'delete'), profileShareController.revokeShare);

// Export router and public resolver router
const publicShareRouter = express.Router();
publicShareRouter.get('/:token', shareLimiter, profileShareController.resolveSharedLink);

module.exports = {
  profileShareRouter: router,
  publicShareRouter,
};
