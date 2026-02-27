const Client = require('../models/Client');

// Get all clients
exports.getClients = async (req, res) => {
  try {
    if (!req.user || !req.user._id) {
        return res.status(401).json({ message: 'Not authorized' });
    }
    // Handle legacy documents that don't have isClient explicitly set in the DB
    const clients = await Client.find({ 
      user: req.user._id, 
      $or: [{ isClient: true }, { isClient: { $exists: false } }] 
    }).lean().sort({ createdAt: -1 });
    res.json(clients);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Get all vendors
exports.getVendors = async (req, res) => {
  try {
    if (!req.user || !req.user._id) {
        return res.status(401).json({ message: 'Not authorized' });
    }
    const vendors = await Client.find({ user: req.user._id, isVendor: true }).lean().sort({ createdAt: -1 });
    res.json(vendors);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Create a new client
exports.createClient = async (req, res) => {
  try {
    const client = new Client({
      ...req.body,
      user: req.user._id
    });

    const newClient = await client.save();
    res.status(201).json(newClient);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// Bulk create clients/vendors
exports.bulkCreateClients = async (req, res) => {
  try {
    const clients = req.body.clients;
    if (!Array.isArray(clients) || clients.length === 0) {
      return res.status(400).json({ message: 'No clients provided for bulk creation.' });
    }

    const createdClients = [];
    const errors = [];
    
    for (const [index, clientData] of clients.entries()) {
      try {
        const client = new Client({
          ...clientData,
          user: req.user._id
        });
        
        const savedClient = await client.save();
        createdClients.push(savedClient);
      } catch (err) {
        errors.push({ index, client: clientData, error: err.message });
      }
    }

    if (errors.length > 0) {
      return res.status(207).json({ 
        message: `Imported ${createdClients.length} clients. ${errors.length} failed.`, 
        count: createdClients.length, 
        clients: createdClients, 
        errors 
      });
    }

    res.status(201).json({ message: `Successfully imported ${createdClients.length} clients.`, count: createdClients.length, clients: createdClients });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Get client by ID
exports.getClientById = async (req, res) => {
  try {
    const client = await Client.findOne({ _id: req.params.id, user: req.user._id });
    if (!client) {
      return res.status(404).json({ message: 'Client not found' });
    }
    res.json(client);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Update client
exports.updateClient = async (req, res) => {
  try {
    const client = await Client.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id },
      req.body,
      { new: true, runValidators: true }
    );
    if (!client) {
      return res.status(404).json({ message: 'Client not found' });
    }
    res.json(client);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// Delete client
exports.deleteClient = async (req, res) => {
  try {
    const client = await Client.findOneAndDelete({ _id: req.params.id, user: req.user._id });
    if (!client) {
      return res.status(404).json({ message: 'Client not found' });
    }
    res.json({ message: 'Client removed' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
