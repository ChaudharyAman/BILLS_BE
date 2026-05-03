const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const {
  getCategories,
  createCategory,
  updateCategory,
  deleteCategory,
  initializeDefaultCategories,
} = require('../controllers/categoryController');

router.use(protect);

router.route('/')
  .get(getCategories)
  .post(createCategory);

router.post('/initialize-defaults', initializeDefaultCategories);

router.route('/:id')
  .put(updateCategory)
  .delete(deleteCategory);

module.exports = router;
