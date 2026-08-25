const express = require('express');
const router = express.Router();
const clientController = require('../controllers/clientController');
const { protect, authorize } = require('../middleware/authMiddleware');

router.get('/', protect, authorize('clients', 'view'), clientController.getClients);
router.post('/', protect, authorize('clients', 'create'), clientController.createClient);
router.post('/bulk', protect, authorize('clients', 'create'), clientController.bulkCreateClients);
router.get('/:id', protect, authorize('clients', 'view'), clientController.getClientById);
router.put('/:id', protect, authorize('clients', 'edit'), clientController.updateClient);
router.delete('/:id', protect, authorize('clients', 'delete'), clientController.deleteClient);

module.exports = router;
