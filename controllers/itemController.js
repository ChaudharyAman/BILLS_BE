const Item = require('../models/Item');

// Get all items
exports.getItems = async (req, res) => {
  try {
    if (!req.user || !req.user._id) {
        return res.status(401).json({ message: 'Not authorized' });
    }
    const items = await Item.find({ user: req.user._id }).sort({ createdAt: -1 });
    res.json(items);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Create a new item
exports.createItem = async (req, res) => {
  const item = new Item({
    ...req.body,
    user: req.user._id
  });

  try {
    const newItem = await item.save();
    res.status(201).json(newItem);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};
