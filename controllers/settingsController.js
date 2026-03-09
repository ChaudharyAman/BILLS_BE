const cloudinary = require('../config/cloudinary');
const fs = require('fs');
const Settings = require('../models/Settings');

// Get Settings (Create default if not exists)
exports.getSettings = async (req, res) => {
  try {
    if (!req.user || !req.user._id) {
        return res.status(401).json({ message: 'Not authorized' });
    }
    let settings = await Settings.findOne({ user: req.user._id }).populate('user', 'username email phone');
    if (!settings) {
      settings = new Settings({ user: req.user._id });
      await settings.save();
      // Re-fetch to populate after creation
      settings = await Settings.findById(settings._id).populate('user', 'username email phone');
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

    // Handle file uploads (Logo & Signature)
    let newLogoUrl = undefined;
    let newSignatureUrl = undefined;

    if (req.files) {
        // Logo Upload
        if (req.files.logo) {
            try {
                const result = await cloudinary.uploader.upload(req.files.logo[0].path, {
                    folder: 'mybill_logos',
                    allowed_formats: ['jpg', 'png', 'jpeg', 'webp'],
                });
                newLogoUrl = result.secure_url;
                fs.unlinkSync(req.files.logo[0].path);
            } catch (error) {
                console.error('Logo Upload Error:', error);
                if (fs.existsSync(req.files.logo[0].path)) fs.unlinkSync(req.files.logo[0].path);
            }
        }

        // Signature Upload
        if (req.files.signature) {
            try {
                const result = await cloudinary.uploader.upload(req.files.signature[0].path, {
                    folder: 'mybill_signatures',
                    allowed_formats: ['jpg', 'png', 'jpeg', 'webp'],
                });
                newSignatureUrl = result.secure_url;
                fs.unlinkSync(req.files.signature[0].path);
            } catch (error) {
                console.error('Signature Upload Error:', error);
                if (fs.existsSync(req.files.signature[0].path)) fs.unlinkSync(req.files.signature[0].path);
            }
        }
    }

    const { 
      username, loginEmail,
      companyName, contactName, website, email, phone, gstin, pan,
      address, defaultTerms, defaultNotes, bankDetails,
      invoicePrefix, proformaPrefix, quotePrefix, receiptPrefix, expensePrefix, purchaseOrderPrefix,
      defaultCurrency, timezone, dateFormat
    } = req.body;

    const settingsUpdate = {
      companyName, contactName, website, email, phone, gstin, pan,
      address, defaultTerms, defaultNotes, bankDetails,
      invoicePrefix, proformaPrefix, quotePrefix, receiptPrefix, expensePrefix, purchaseOrderPrefix,
      defaultCurrency, timezone, dateFormat
    };

    // Remove undefined fields
    Object.keys(settingsUpdate).forEach(key => settingsUpdate[key] === undefined && delete settingsUpdate[key]);

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
                 console.error('Update Settings: Username/Email taken', { 
                     username, 
                     email: loginEmail, 
                     existingId: existingUser._id 
                 });
                 if (req.files) {
                    if (req.files.logo && fs.existsSync(req.files.logo[0].path)) fs.unlinkSync(req.files.logo[0].path);
                    if (req.files.signature && fs.existsSync(req.files.signature[0].path)) fs.unlinkSync(req.files.signature[0].path);
                 }
                 return res.status(400).json({ message: 'Username or Email already taken' });
             }

             await User.findByIdAndUpdate(req.user._id, userUpdate);
        }
    }

    if (!settings) {
      // Create new if not exists
      const settingsData = { ...settingsUpdate, user: req.user._id };
      if (newLogoUrl) settingsData.logoUrl = newLogoUrl;
      if (newSignatureUrl) settingsData.signatureUrl = newSignatureUrl;
      settings = new Settings(settingsData);
    } else {
      // Update existing
      if (newLogoUrl) settingsUpdate.logoUrl = newLogoUrl;
      if (newSignatureUrl) settingsUpdate.signatureUrl = newSignatureUrl;
      Object.assign(settings, settingsUpdate);
    }
    
    await settings.save();
    // Return populated settings
    const populatedSettings = await Settings.findById(settings._id).populate('user', 'username email phone');
    res.json(populatedSettings);
  } catch (error) {
    // Cleanup local files if error
    if (req.files) {
        if (req.files.logo && fs.existsSync(req.files.logo[0].path)) fs.unlinkSync(req.files.logo[0].path);
        if (req.files.signature && fs.existsSync(req.files.signature[0].path)) fs.unlinkSync(req.files.signature[0].path);
    }
    console.error('Update Settings Error:', error);
    res.status(400).json({ message: error.message });
  }
};
