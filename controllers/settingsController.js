const cloudinary = require('../config/cloudinary');
const fs = require('fs');
const Settings = require('../models/Settings');

// Get Settings (Create default if not exists)
exports.getSettings = async (req, res) => {
  try {
    if (!req.user || !req.user._id) {
        return res.status(401).json({ message: 'Not authorized' });
    }
    let settings = await Settings.findOne({ user: req.user._id });
    if (!settings) {
      settings = new Settings({ user: req.user._id });
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
    if (!req.user || !req.user._id) {
        return res.status(401).json({ message: 'Not authorized' });
    }
    let settings = await Settings.findOne({ user: req.user._id });

    // Handle file upload first to get URL
    let newLogoUrl = undefined;
    if (req.file) {
      try {
        const result = await cloudinary.uploader.upload(req.file.path, {
          folder: 'mybill_logos',
          allowed_formats: ['jpg', 'png', 'jpeg', 'webp'],
        });
        newLogoUrl = result.secure_url;
        fs.unlinkSync(req.file.path); // Clean up local file
      } catch (uploadError) {
        console.error('Cloudinary Upload Error:', uploadError);
        // Clean up even if upload fails
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        return res.status(500).json({ message: 'Image upload failed' });
      }
    }

    if (!settings) {
      // Create new if not exists
      const settingsData = { ...req.body, user: req.user._id };
      if (newLogoUrl) settingsData.logoUrl = newLogoUrl;
      settings = new Settings(settingsData);
    } else {
      // Update existing
      if (newLogoUrl) req.body.logoUrl = newLogoUrl;
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
