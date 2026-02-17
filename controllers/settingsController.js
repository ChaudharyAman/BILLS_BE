const cloudinary = require('../config/cloudinary');
const fs = require('fs');
const Settings = require('../models/Settings');

// Get Settings (Create default if not exists)
exports.getSettings = async (req, res) => {
  try {
    if (!req.user || !req.user._id) {
        return res.status(401).json({ message: 'Not authorized' });
    }
    let settings = await Settings.findOne({ user: req.user._id }).populate('user', 'username email');
    if (!settings) {
      settings = new Settings({ user: req.user._id });
      await settings.save();
      // Re-fetch to populate after creation
      settings = await Settings.findById(settings._id).populate('user', 'username email');
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

    const { username, loginEmail, ...settingsUpdate } = req.body;

    // Update User model if username/loginEmail provided
    if (username || loginEmail) {
        const userUpdate = {};
        if (username) userUpdate.username = username;
        if (loginEmail) userUpdate.email = loginEmail.toLowerCase();
        
        // Check for duplicates if changing
        if (Object.keys(userUpdate).length > 0) {
             const User = require('../models/User'); // Lazy load to avoid circular dependency if any
             
             // Check if username/email is taken by another user
             const checkingQuery = [];
             if (username) checkingQuery.push({ username });
             if (loginEmail) checkingQuery.push({ email: loginEmail.toLowerCase() });

             const existingUser = await User.findOne({ 
                 $or: checkingQuery,
                 _id: { $ne: req.user._id } // Exclude current user
             });
             
             if (existingUser) {
                 if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
                 return res.status(400).json({ message: 'Username or Email already taken' });
             }

             await User.findByIdAndUpdate(req.user._id, userUpdate);
        }
    }

    if (!settings) {
      // Create new if not exists
      const settingsData = { ...settingsUpdate, user: req.user._id };
      if (newLogoUrl) settingsData.logoUrl = newLogoUrl;
      settings = new Settings(settingsData);
    } else {
      // Update existing
      if (newLogoUrl) settingsUpdate.logoUrl = newLogoUrl;
      Object.assign(settings, settingsUpdate);
    }
    
    await settings.save();
    // Return populated settings
    const populatedSettings = await Settings.findById(settings._id).populate('user', 'username email');
    res.json(populatedSettings);
  } catch (error) {
    // Cleanup local file if error
    if (req.file && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
    }
    console.error('Update Settings Error:', error);
    res.status(400).json({ message: error.message });
  }
};
