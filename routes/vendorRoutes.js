const express = require('express');
const router = express.Router();
const clientController = require('../controllers/clientController');
const { protect } = require('../middleware/authMiddleware');

// Middleware to enforce isVendor: true for all vendor routes
const enforceVendor = (req, res, next) => {
  req.body.isVendor = true;
  if (req.body.isClient === undefined) req.body.isClient = false;
  next();
};

router.get('/', protect, clientController.getVendors);
router.post('/', protect, enforceVendor, clientController.createClient);
router.post('/bulk', protect, clientController.bulkCreateClients);
router.get('/:id', protect, clientController.getClientById);
router.put('/:id', protect, clientController.updateClient);
router.delete('/:id', protect, clientController.deleteClient);

module.exports = router;
