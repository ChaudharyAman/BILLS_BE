const Client = require('../models/Client');
const escapeRegex = require('../utils/escapeRegex');

const mergeClientFields = (existing, incoming) => {
  if (!existing || !incoming) return;

  // Simple fields
  const fields = [
    'email', 'phone', 'gstin', 'pan', 'tan', 'tin', 'vat', 'website', 
    'notes', 'placeOfSupply', 'terms', 'vendorCode', 'facebook', 'lst', 'cst', 'dlNo'
  ];
  fields.forEach(field => {
    if (!existing[field] && incoming[field]) {
      existing[field] = incoming[field];
    }
  });

  // Boolean flags - if either is true, set it to true
  if (incoming.isClient !== undefined) {
    existing.isClient = existing.isClient || incoming.isClient;
  }
  if (incoming.isVendor !== undefined) {
    existing.isVendor = existing.isVendor || incoming.isVendor;
  }
  if (incoming.useForDispatch !== undefined) {
    existing.useForDispatch = existing.useForDispatch || incoming.useForDispatch;
  }
  if (incoming.clientWiseItemPrice !== undefined) {
    existing.clientWiseItemPrice = existing.clientWiseItemPrice || incoming.clientWiseItemPrice;
  }

  // Currency
  if ((!existing.currency || existing.currency === 'INR') && incoming.currency) {
    existing.currency = incoming.currency;
  }

  // Vendor relation
  if ((!existing.vendorRelation || existing.vendorRelation === 'Bought From') && incoming.vendorRelation) {
    existing.vendorRelation = incoming.vendorRelation;
  }

  // TDS settings
  if (incoming.tds_applicable !== undefined) {
    existing.tds_applicable = existing.tds_applicable || incoming.tds_applicable;
  }
  if (!existing.default_tds_section && incoming.default_tds_section) {
    existing.default_tds_section = incoming.default_tds_section;
  }
  if (!existing.default_tds_rate && incoming.default_tds_rate) {
    existing.default_tds_rate = incoming.default_tds_rate;
  }
  if (!existing.tds_default_section && incoming.tds_default_section) {
    existing.tds_default_section = incoming.tds_default_section;
  }
  if (!existing.tds_default_rate && incoming.tds_default_rate) {
    existing.tds_default_rate = incoming.tds_default_rate;
  }

  // Address objects merging
  const mergeAddress = (existingAddr, incomingAddr) => {
    if (!incomingAddr) return;
    const addrFields = ['line1', 'line2', 'city', 'state', 'zip', 'country'];
    addrFields.forEach(f => {
      if (!existingAddr[f] && incomingAddr[f]) {
        existingAddr[f] = incomingAddr[f];
      }
    });
  };

  if (incoming.billingAddress) {
    if (!existing.billingAddress) {
      existing.billingAddress = incoming.billingAddress;
    } else {
      mergeAddress(existing.billingAddress, incoming.billingAddress);
    }
  }

  if (incoming.shippingAddress) {
    if (!existing.shippingAddress) {
      existing.shippingAddress = incoming.shippingAddress;
    } else {
      mergeAddress(existing.shippingAddress, incoming.shippingAddress);
    }
  }

  // Contacts array
  if (Array.isArray(incoming.contacts) && incoming.contacts.length > 0) {
    if (!Array.isArray(existing.contacts) || existing.contacts.length === 0) {
      existing.contacts = incoming.contacts;
    } else {
      incoming.contacts.forEach(incomingContact => {
        const isDuplicate = existing.contacts.some(c => 
          (c.email && c.email.toLowerCase() === (incomingContact.email || '').toLowerCase()) ||
          (c.phone && c.phone === incomingContact.phone)
        );
        if (!isDuplicate) {
          existing.contacts.push(incomingContact);
        }
      });
    }
  }
};

// Get all clients
exports.getClients = async (req, res) => {
  try {
    if (!req.user || !req.user._id) { return res.status(401).json({ message: 'Not authorized' }); }

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const search = req.query.search || '';
    const skip = (page - 1) * limit;

    let query = { 
      user: req.user._id, 
      $or: [{ isClient: true }, { isClient: { $exists: false } }] 
    };

    if (search) { 
      const safeSearch = escapeRegex(search);
      query.name = { $regex: safeSearch, $options: 'i' }; 
    }

    const total = await Client.countDocuments(query);
    const clients = await Client.find(query)
      .lean()
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    res.json({
      data: clients,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit)
    });
  } catch (error) { res.status(500).json({ message: error.message }); }
};

// Get all vendors
exports.getVendors = async (req, res) => {
  try {
    if (!req.user || !req.user._id) { return res.status(401).json({ message: 'Not authorized' }); }

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const search = req.query.search || '';
    const skip = (page - 1) * limit;

    let query = { user: req.user._id, isVendor: true };
    if (search) { 
      const safeSearch = escapeRegex(search);
      query.name = { $regex: safeSearch, $options: 'i' }; 
    }

    const total = await Client.countDocuments(query);
    const vendors = await Client.find(query)
      .lean()
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    res.json({
      data: vendors,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit)
    });
  } catch (error) { res.status(500).json({ message: error.message }); }
};

// Create a new client
exports.createClient = async (req, res) => {
  try {
    const { 
      name, email, phone, billingAddress, shippingAddress, 
      gstin, pan, terms, isClient, isVendor, notes, placeOfSupply,
      contacts, clientType, gstTreatment, tan, tin, vat, website, currency,
      useForDispatch, vendorCode, clientWiseItemPrice, vendorRelation,
      facebook, lst, cst, dlNo, openingBalance,
      tds_applicable, default_tds_section, default_tds_rate
    } = req.body;

    if (name && typeof name === 'string') {
      const existingClient = await Client.findOne({
        user: req.user._id,
        name: { $regex: new RegExp("^" + escapeRegex(name.trim()) + "$", "i") }
      });

      if (existingClient) {
        mergeClientFields(existingClient, req.body);
        const savedClient = await existingClient.save();
        return res.status(200).json(savedClient);
      }
    }

    const client = new Client({
      name, email, phone, billingAddress, shippingAddress, 
      gstin, pan, terms, isClient, isVendor, notes, placeOfSupply,
      contacts, clientType, gstTreatment, tan, tin, vat, website, currency,
      useForDispatch, vendorCode, clientWiseItemPrice, vendorRelation,
      facebook, lst, cst, dlNo, openingBalance,
      tds_applicable, default_tds_section, default_tds_rate,
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
        if (!clientData.name || typeof clientData.name !== 'string') {
          throw new Error('Name is required');
        }

        const existingClient = await Client.findOne({
          user: req.user._id,
          name: { $regex: new RegExp("^" + escapeRegex(clientData.name.trim()) + "$", "i") }
        });

        if (existingClient) {
          mergeClientFields(existingClient, clientData);
          const savedClient = await existingClient.save();
          createdClients.push(savedClient);
        } else {
          const client = new Client({
            name: clientData.name,
            email: clientData.email,
            phone: clientData.phone,
            billingAddress: clientData.billingAddress,
            shippingAddress: clientData.shippingAddress,
            gstin: clientData.gstin,
            pan: clientData.pan,
            terms: clientData.terms,
            isClient: clientData.isClient,
            isVendor: clientData.isVendor,
            notes: clientData.notes,
            placeOfSupply: clientData.placeOfSupply,
            user: req.user._id
          });
          
          const savedClient = await client.save();
          createdClients.push(savedClient);
        }
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
    const { 
      name, email, phone, billingAddress, shippingAddress, 
      gstin, pan, terms, isClient, isVendor, notes, placeOfSupply,
      contacts, clientType, gstTreatment, tan, tin, vat, website, currency,
      useForDispatch, vendorCode, clientWiseItemPrice, vendorRelation,
      facebook, lst, cst, dlNo, openingBalance,
      tds_applicable, default_tds_section, default_tds_rate
    } = req.body;

    const updateData = {
      name, email, phone, billingAddress, shippingAddress, 
      gstin, pan, terms, isClient, isVendor, notes, placeOfSupply,
      contacts, clientType, gstTreatment, tan, tin, vat, website, currency,
      useForDispatch, vendorCode, clientWiseItemPrice, vendorRelation,
      facebook, lst, cst, dlNo, openingBalance,
      tds_applicable, default_tds_section, default_tds_rate
    };

    // Remove undefined fields so they don't overwrite existing data with nulls if not provided in the request
    Object.keys(updateData).forEach(key => updateData[key] === undefined && delete updateData[key]);

    const client = await Client.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id },
      updateData,
      { returnDocument: 'after', runValidators: true }
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
