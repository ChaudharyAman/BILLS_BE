const CompanyDocument = require('../models/CompanyDocument');
const { getTenantFilter, attachTenant } = require('../utils/tenantHelper');
const escapeRegex = require('../utils/escapeRegex');

// GET /api/company-documents
exports.getDocuments = async (req, res) => {
  try {
    const tenantFilter = getTenantFilter(req);
    const { category, search } = req.query;

    const query = {
      ...tenantFilter,
      isDeleted: { $ne: true },
    };

    if (category && category !== 'All') {
      query.category = category;
    }

    if (search && search.trim()) {
      const safeSearch = escapeRegex(search.trim());
      query.$or = [
        { title: { $regex: safeSearch, $options: 'i' } },
        { originalName: { $regex: safeSearch, $options: 'i' } },
        { notes: { $regex: safeSearch, $options: 'i' } },
        { referenceNumber: { $regex: safeSearch, $options: 'i' } },
      ];
    }

    // Retrieve documents without the raw buffer
    const documents = await CompanyDocument.find(query)
      .select('-buffer')
      .sort({ createdAt: -1 })
      .lean();

    // Summary counts by category
    const allDocsForSummary = await CompanyDocument.find({
      ...tenantFilter,
      isDeleted: { $ne: true },
    }).select('category sizeBytes').lean();

    const categoryCounts = {};
    let totalStorageBytes = 0;
    for (const doc of allDocsForSummary) {
      const cat = doc.category || 'General Documents';
      categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
      totalStorageBytes += (Number(doc.sizeBytes) || 0);
    }

    res.json({
      success: true,
      data: documents,
      total: documents.length,
      categoryCounts,
      totalStorageBytes,
    });
  } catch (error) {
    console.error('Error fetching company documents:', error);
    res.status(500).json({ message: error.message || 'Failed to fetch company documents' });
  }
};

// POST /api/company-documents
exports.uploadDocument = async (req, res) => {
  try {
    const {
      title,
      category,
      notes,
      referenceNumber,
      expiryDate,
      originalName,
      mimeType,
      fileBase64,
    } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ message: 'Document title is required' });
    }

    let buffer = null;
    let finalOriginalName = originalName || 'document';
    let finalMimeType = mimeType || 'application/octet-stream';
    let finalSizeBytes = 0;

    // Support 1: Multer upload (if file in req.file)
    if (req.file) {
      buffer = req.file.buffer;
      finalOriginalName = req.file.originalname || finalOriginalName;
      finalMimeType = req.file.mimetype || finalMimeType;
      finalSizeBytes = req.file.size || buffer.length;
    } 
    // Support 2: Base64 payload
    else if (fileBase64) {
      const cleanBase64 = String(fileBase64).replace(/^data:[^;]+;base64,/, '');
      buffer = Buffer.from(cleanBase64, 'base64');
      finalSizeBytes = buffer.length;
    }

    if (!buffer || buffer.length === 0) {
      return res.status(400).json({ message: 'A valid file or document must be provided' });
    }

    // Limit single file size to 25MB
    if (finalSizeBytes > 25 * 1024 * 1024) {
      return res.status(400).json({ message: 'File size exceeds maximum 25MB limit' });
    }

    const payload = attachTenant(req, {
      title: title.trim(),
      category: category || 'General Documents',
      notes: (notes || '').trim(),
      referenceNumber: (referenceNumber || '').trim(),
      expiryDate: expiryDate ? new Date(expiryDate) : undefined,
      originalName: finalOriginalName,
      mimeType: finalMimeType,
      sizeBytes: finalSizeBytes,
      buffer,
      uploadedBy: req.user?._id,
    });

    const newDoc = await CompanyDocument.create(payload);

    const docObj = newDoc.toObject();
    delete docObj.buffer;

    res.status(201).json({
      success: true,
      message: 'Company document uploaded successfully',
      data: docObj,
    });
  } catch (error) {
    console.error('Error uploading company document:', error);
    res.status(500).json({ message: error.message || 'Failed to upload document' });
  }
};

// GET /api/company-documents/:id/view
exports.viewDocument = async (req, res) => {
  try {
    const tenantFilter = getTenantFilter(req);
    const doc = await CompanyDocument.findOne({
      _id: req.params.id,
      ...tenantFilter,
      isDeleted: { $ne: true },
    });

    if (!doc || !doc.buffer) {
      return res.status(404).json({ message: 'Document not found' });
    }

    res.set({
      'Content-Type': doc.mimeType || 'application/octet-stream',
      'Content-Disposition': `inline; filename="${encodeURIComponent(doc.originalName)}"`,
      'Content-Length': doc.buffer.length,
      'Cache-Control': 'private, max-age=3600',
    });

    return res.send(doc.buffer);
  } catch (error) {
    console.error('Error viewing document:', error);
    res.status(500).json({ message: 'Failed to view document' });
  }
};

// GET /api/company-documents/:id/download
exports.downloadDocument = async (req, res) => {
  try {
    const tenantFilter = getTenantFilter(req);
    const doc = await CompanyDocument.findOne({
      _id: req.params.id,
      ...tenantFilter,
      isDeleted: { $ne: true },
    });

    if (!doc || !doc.buffer) {
      return res.status(404).json({ message: 'Document not found' });
    }

    res.set({
      'Content-Type': doc.mimeType || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(doc.originalName)}"`,
      'Content-Length': doc.buffer.length,
    });

    return res.send(doc.buffer);
  } catch (error) {
    console.error('Error downloading document:', error);
    res.status(500).json({ message: 'Failed to download document' });
  }
};

// PATCH /api/company-documents/:id
exports.updateDocument = async (req, res) => {
  try {
    const tenantFilter = getTenantFilter(req);
    const { title, category, notes, referenceNumber, expiryDate } = req.body;

    const updates = {};
    if (title !== undefined) updates.title = title.trim();
    if (category !== undefined) updates.category = category;
    if (notes !== undefined) updates.notes = notes.trim();
    if (referenceNumber !== undefined) updates.referenceNumber = referenceNumber.trim();
    if (expiryDate !== undefined) updates.expiryDate = expiryDate ? new Date(expiryDate) : null;

    const doc = await CompanyDocument.findOneAndUpdate(
      { _id: req.params.id, ...tenantFilter, isDeleted: { $ne: true } },
      { $set: updates },
      { new: true }
    ).select('-buffer');

    if (!doc) {
      return res.status(404).json({ message: 'Document not found' });
    }

    res.json({
      success: true,
      message: 'Document updated successfully',
      data: doc,
    });
  } catch (error) {
    console.error('Error updating document:', error);
    res.status(500).json({ message: error.message || 'Failed to update document' });
  }
};

// DELETE /api/company-documents/:id
exports.deleteDocument = async (req, res) => {
  try {
    const tenantFilter = getTenantFilter(req);
    const doc = await CompanyDocument.findOne({
      _id: req.params.id,
      ...tenantFilter,
      isDeleted: { $ne: true },
    });

    if (!doc) {
      return res.status(404).json({ message: 'Document not found' });
    }

    doc.isDeleted = true;
    await doc.save();

    res.json({
      success: true,
      message: 'Document deleted successfully',
    });
  } catch (error) {
    console.error('Error deleting document:', error);
    res.status(500).json({ message: error.message || 'Failed to delete document' });
  }
};
