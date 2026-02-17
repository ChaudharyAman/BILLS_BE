const express = require('express');
const router = express.Router();
const clientController = require('../controllers/clientController');
const { protect } = require('../middleware/authMiddleware');

router.get('/', protect, clientController.getClients);
router.post('/', protect, clientController.createClient);

module.exports = router;
