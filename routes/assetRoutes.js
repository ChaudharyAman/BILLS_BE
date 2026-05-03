const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const {
  getAssets,
  getAssetById,
  createAsset,
  updateAsset,
  deleteAsset,
} = require('../controllers/assetController');

router.use(protect);

router.route('/')
  .get(getAssets)
  .post(createAsset);

router.route('/:id')
  .get(getAssetById)
  .put(updateAsset)
  .delete(deleteAsset);

module.exports = router;
