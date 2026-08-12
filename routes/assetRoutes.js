const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/authMiddleware');
const {
  getAssets,
  getAssetById,
  createAsset,
  updateAsset,
  deleteAsset,
} = require('../controllers/assetController');

router.use(protect);

router.route('/')
  .get(authorize('assets', 'view'), getAssets)
  .post(authorize('assets', 'create'), createAsset);

router.route('/:id')
  .get(authorize('assets', 'view'), getAssetById)
  .put(authorize('assets', 'edit'), updateAsset)
  .delete(authorize('assets', 'delete'), deleteAsset);

module.exports = router;
