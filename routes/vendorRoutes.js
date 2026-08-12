const express = require('express');
const router = express.Router();
const clientController = require('../controllers/clientController');
const { protect, authorize } = require('../middleware/authMiddleware');

// Middleware to enforce isVendor: true for all vendor routes
const enforceVendor = (req, res, next) => {
  req.body.isVendor = true;
  if (req.body.isClient === undefined) req.body.isClient = false;
  if (Array.isArray(req.body.clients)) {
    req.body.clients = req.body.clients.map((client) => ({
      ...client,
      isVendor: true,
      isClient: client.isClient === undefined ? false : client.isClient,
    }));
  }
  next();
};

router.get('/', protect, authorize('vendors', 'view'), clientController.getVendors);
router.post('/', protect, authorize('vendors', 'create'), enforceVendor, clientController.createClient);
router.post('/bulk', protect, authorize('vendors', 'create'), enforceVendor, clientController.bulkCreateClients);
router.get('/:id', protect, authorize('vendors', 'view'), clientController.getClientById);
router.put('/:id', protect, authorize('vendors', 'edit'), clientController.updateClient);
router.delete('/:id', protect, authorize('vendors', 'delete'), clientController.deleteClient);

module.exports = router;
