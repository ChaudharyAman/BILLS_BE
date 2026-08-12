const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/authMiddleware');
const {
  getCategories,
  createCategory,
  updateCategory,
  deleteCategory,
  initializeDefaultCategories,
} = require('../controllers/categoryController');

router.use(protect);

router.route('/')
  .get(authorize('categories', 'view'), getCategories)
  .post(authorize('categories', 'create'), createCategory);

router.post('/initialize-defaults', authorize('categories', 'create'), initializeDefaultCategories);

router.route('/:id')
  .put(authorize('categories', 'edit'), updateCategory)
  .delete(authorize('categories', 'delete'), deleteCategory);

module.exports = router;
