const Item = require('../models/Item');
const Counter = require('../models/Counter');

// Get all items
exports.getItems = async (req, res) => {
  try {
    if (!req.user || !req.user._id) { return res.status(401).json({ message: 'Not authorized' }); }

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const search = req.query.search || '';
    const skip = (page - 1) * limit;

    let query = { user: req.user._id };

    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { sku: { $regex: search, $options: 'i' } },
        { hsnCode: { $regex: search, $options: 'i' } }
      ];
    }

    const total = await Item.countDocuments(query);
    const items = await Item.find(query)
      .lean()
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    res.json({
      data: items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit)
    });
  } catch (error) { res.status(500).json({ message: error.message }); }
};

// Create a new item
exports.createItem = async (req, res) => {
  let { sku, name, type } = req.body;

  if (!sku || sku.trim() === '') {
    const counter = await Counter.findOneAndUpdate(
      { id: 'skuSeq' },
      { $inc: { seq: 1 } },
      { returnDocument: 'after', upsert: true }
    );
    const resolvedType = type === 'Service' ? 'SRV' : 'GDS';
    const prefix = 'TQ';
    sku = `${prefix}-${resolvedType}-${counter.seq.toString().padStart(3, '0')}`;
  }

  const item = new Item({
    ...req.body,
    sku,
    user: req.user._id
  });

  try {
    const newItem = await item.save();
    res.status(201).json(newItem);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// Bulk create items
exports.bulkCreateItems = async (req, res) => {
  try {
    const items = req.body.items;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: 'No items provided for bulk creation.' });
    }

    const createdItems = [];
    const errors = [];
    for (const [index, itemData] of items.entries()) {
      try {
        let { sku, name, type } = itemData;

        if (!sku || sku.trim() === '') {
          const counter = await Counter.findOneAndUpdate(
            { id: 'skuSeq' },
            { $inc: { seq: 1 } },
            { returnDocument: 'after', upsert: true }
          );
          const resolvedType = type === 'Service' ? 'SRV' : 'GDS';
          const prefix = 'TQ';
          sku = `${prefix}-${resolvedType}-${counter.seq.toString().padStart(3, '0')}`;
        }

        const item = new Item({
          ...itemData,
          sku,
          user: req.user._id
        });
        
        const savedItem = await item.save();
        createdItems.push(savedItem);
      } catch (err) {
        errors.push({ index, item: itemData, error: err.message });
      }
    }

    if (errors.length > 0) {
      return res.status(207).json({ 
        message: `Imported ${createdItems.length} items. ${errors.length} failed.`, 
        count: createdItems.length, 
        items: createdItems, 
        errors 
      });
    }

    res.status(201).json({ message: `Successfully imported ${createdItems.length} items.`, count: createdItems.length, items: createdItems });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Get item by ID
exports.getItemById = async (req, res) => {
  try {
    const item = await Item.findOne({ _id: req.params.id, user: req.user._id });
    if (!item) {
      return res.status(404).json({ message: 'Item not found' });
    }
    res.json(item);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Update item
exports.updateItem = async (req, res) => {
  try {
    let { sku, name, type } = req.body;

    if (!sku || sku.trim() === '') {
      const counter = await Counter.findOneAndUpdate(
        { id: 'skuSeq' },
        { $inc: { seq: 1 } },
        { returnDocument: 'after', upsert: true }
      );
      const resolvedType = type === 'Service' ? 'SRV' : 'GDS';
      const prefix = 'TQ';
      sku = `${prefix}-${resolvedType}-${counter.seq.toString().padStart(3, '0')}`;
      req.body.sku = sku;
    }

    // Prevent overwriting the user field
    delete req.body.user;

    const item = await Item.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id },
      req.body,
      { new: true, runValidators: true }
    );
    if (!item) {
      return res.status(404).json({ message: 'Item not found' });
    }
    res.json(item);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// Delete item
exports.deleteItem = async (req, res) => {
  try {
    const item = await Item.findOneAndDelete({ _id: req.params.id, user: req.user._id });
    if (!item) {
      return res.status(404).json({ message: 'Item not found' });
    }
    res.json({ message: 'Item removed' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
