const cloudinary = require('../config/cloudinary');
const fs = require('fs');
const Settings = require('../models/Settings');

// Get Settings (Create default if not exists)
exports.getSettings = async (req, res) => {
  try {
    let settings = await Settings.findOne();
    if (!settings) {
      settings = new Settings();
      await settings.save();
    }
    res.json(settings);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Update Settings
exports.updateSettings = async (req, res) => {
  try {
    let settings = await Settings.findOne();
    if (!settings) {
      settings = new Settings(req.body);
    } else {
      // If file uploaded, upload to Cloudinary
      if (req.file) {
        const result = await cloudinary.uploader.upload(req.file.path, {
          folder: 'mybill_logos',
          allowed_formats: ['jpg', 'png', 'jpeg', 'webp'],
        });
        
        // Update logoUrl
        req.body.logoUrl = result.secure_url;
        
        // Remove local file
        fs.unlinkSync(req.file.path);
      }

      Object.assign(settings, req.body);
    }
    await settings.save();
    res.json(settings);
  } catch (error) {
    // Cleanup local file if error
    if (req.file && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
    }
    console.error('Update Settings Error:', error);
    res.status(400).json({ message: error.message });
  }
};
