const express = require('express');
const router = express.Router();
const clientController = require('../controllers/clientController');
const { protect } = require('../middleware/authMiddleware');

router.get('/', protect, clientController.getVendors);
router.post('/', protect, clientController.createClient);
router.post('/bulk', protect, clientController.bulkCreateClients);
router.get('/:id', protect, clientController.getClientById);
router.put('/:id', protect, clientController.updateClient);
router.delete('/:id', protect, clientController.deleteClient);

module.exports = router;
