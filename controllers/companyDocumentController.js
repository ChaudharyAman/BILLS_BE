const mongoose = require('mongoose');
const CompanyDocument = require('../models/CompanyDocument');
const DocumentFolder = require('../models/DocumentFolder');
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

    // Retrieve tenant custom folders
    const customFolders = await DocumentFolder.find(tenantFilter).sort({ createdAt: 1 }).lean();

    res.json({
      success: true,
      data: documents,
      total: documents.length,
      categoryCounts,
      totalStorageBytes,
      customFolders: customFolders || [],
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

// GET /api/company-documents/folders
exports.getFolders = async (req, res) => {
  try {
    const tenantFilter = getTenantFilter(req);
    const folders = await DocumentFolder.find(tenantFilter).sort({ createdAt: 1 }).lean();
    res.json({ success: true, data: folders });
  } catch (error) {
    console.error('Error fetching document folders:', error);
    res.status(500).json({ message: error.message || 'Failed to fetch folders' });
  }
};

// POST /api/company-documents/folders
exports.createFolder = async (req, res) => {
  try {
    const { name, color, icon } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ message: 'Folder name is required' });
    }

    const trimmedName = name.trim();

    if (trimmedName.toLowerCase() === 'all') {
      return res.status(400).json({ message: '"All" is a reserved folder name.' });
    }

    const tenantFilter = getTenantFilter(req);

    const existing = await DocumentFolder.findOne({
      ...tenantFilter,
      name: { $regex: new RegExp(`^${escapeRegex(trimmedName)}$`, 'i') },
    });
    if (existing) {
      return res.status(400).json({ message: 'A folder with this name already exists' });
    }

    const newFolder = await DocumentFolder.create(attachTenant(req, {
      name: trimmedName,
      color: color || 'text-indigo-500 bg-indigo-50 dark:bg-indigo-900/30',
      icon: icon || 'Folder',
    }));

    res.status(201).json({
      success: true,
      message: 'Folder created successfully',
      data: newFolder,
    });
  } catch (error) {
    console.error('Error creating document folder:', error);
    if (error.code === 11000) {
      return res.status(400).json({ message: 'A folder with this name already exists' });
    }
    res.status(500).json({ message: error.message || 'Failed to create folder' });
  }
};

// DELETE /api/company-documents/folders/:id
exports.deleteFolder = async (req, res) => {
  try {
    const { id } = req.params;
    const tenantFilter = getTenantFilter(req);

    const query = {
      ...tenantFilter,
      $or: [
        mongoose.isValidObjectId(id) ? { _id: id } : null,
        { name: id },
      ].filter(Boolean),
    };

    const folder = await DocumentFolder.findOne(query);
    if (!folder) {
      return res.status(404).json({ message: 'Folder not found' });
    }

    await DocumentFolder.deleteOne({ _id: folder._id });

    // Reassign any documents in this deleted folder to 'General Documents'
    await CompanyDocument.updateMany(
      { ...tenantFilter, category: folder.name },
      { $set: { category: 'General Documents' } }
    );

    res.json({
      success: true,
      message: `Folder "${folder.name}" deleted. Any existing documents were moved to General Documents.`,
    });
  } catch (error) {
    console.error('Error deleting document folder:', error);
    res.status(500).json({ message: error.message || 'Failed to delete folder' });
  }
};

// POST /api/company-documents/send-email or POST /api/company-documents/:id/send-email
exports.sendDocumentEmail = async (req, res) => {
  try {
    const tenantFilter = getTenantFilter(req);
    const { documentIds, documentId, recipientEmail, cc, subject, message } = req.body;

    const targetRecipient = (recipientEmail || '').trim();
    if (!targetRecipient) {
      return res.status(400).json({ message: 'Recipient email address is required.' });
    }

    const rawIds = Array.isArray(documentIds) && documentIds.length > 0
      ? documentIds
      : (documentId ? [documentId] : (req.params.id ? [req.params.id] : []));

    const validIds = rawIds.filter((id) => mongoose.Types.ObjectId.isValid(id));
    if (validIds.length === 0) {
      return res.status(400).json({ message: 'Please select at least one document to send.' });
    }

    const docs = await CompanyDocument.find({
      _id: { $in: validIds },
      ...tenantFilter,
      isDeleted: { $ne: true },
    });

    if (!docs.length) {
      return res.status(404).json({ message: 'Selected document(s) not found.' });
    }

    const Settings = require('../models/Settings');
    const settings = await Settings.findOne(tenantFilter).lean() || {};
    const companyName = settings.companyName || 'Flance';

    const attachments = [];
    for (const d of docs) {
      if (d.buffer) {
        const buf = Buffer.isBuffer(d.buffer) ? d.buffer : Buffer.from(d.buffer);
        attachments.push({
          filename: d.originalName || `${d.title || 'Document'}.pdf`,
          content: buf,
          contentType: d.mimeType || 'application/octet-stream',
        });
      }
    }

    const mailService = require('../utils/mailService');
    const defaultSubject = `Document${docs.length > 1 ? 's' : ''}: ${docs[0].title || 'Shared Document'} from ${companyName}`;
    const emailSubject = (subject || defaultSubject).trim();

    const emailHtml = `
      <!DOCTYPE html>
      <html lang="en">
      <head><meta charset="utf-8"></head>
      <body style="margin: 0; padding: 0; background-color: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #1e293b;">
        <table width="100%" border="0" cellpadding="0" cellspacing="0" style="padding: 32px 16px;">
          <tr>
            <td align="center">
              <table width="100%" border="0" cellpadding="0" cellspacing="0" style="max-width: 580px; background-color: #ffffff; border-radius: 16px; overflow: hidden; border: 1px solid #e2e8f0; box-shadow: 0 4px 20px rgba(0,0,0,0.05);">
                <tr>
                  <td style="padding: 24px 32px; border-bottom: 1px solid #f1f5f9; background: #ffffff;">
                    <h2 style="margin: 0; font-size: 20px; font-weight: 700; color: #0f172a;">${companyName}</h2>
                    <div style="font-size: 12px; color: #64748b; margin-top: 4px;">Shared Documents Vault</div>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 24px 32px;">
                    <p style="margin: 0 0 14px; font-size: 14px; color: #334155; line-height: 1.5;">
                      Hello,
                    </p>
                    <p style="margin: 0 0 16px; font-size: 14px; color: #475569; line-height: 1.5;">
                      Please find the attached document${docs.length > 1 ? 's' : ''} shared by <strong>${companyName}</strong>.
                    </p>
                    ${message ? `
                      <div style="margin: 16px 0; padding: 14px 18px; background-color: #f8fafc; border-left: 4px solid #0d9488; border-radius: 8px; font-size: 13px; color: #334155; line-height: 1.5;">
                        ${message.replace(/\n/g, '<br/>')}
                      </div>
                    ` : ''}
                    <div style="margin-top: 20px; border: 1px solid #e2e8f0; border-radius: 12px; padding: 12px 16px; background-color: #fafbfc;">
                      <div style="font-size: 11px; font-weight: 700; text-transform: uppercase; color: #64748b; margin-bottom: 8px;">Attached Document${docs.length > 1 ? 's' : ''} (${docs.length})</div>
                      ${docs.map((d) => `
                        <div style="padding: 6px 0; font-size: 13px; color: #1e293b; border-bottom: 1px dashed #e2e8f0; display: flex; justify-content: space-between;">
                          <span>📄 <strong>${d.title}</strong> <span style="font-size: 11px; color: #64748b;">(${d.originalName})</span></span>
                          <span style="font-size: 11px; color: #0d9488; font-weight: 600;">${d.category}</span>
                        </div>
                      `).join('')}
                    </div>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 16px 32px; background-color: #f8fafc; border-top: 1px solid #f1f5f9; font-size: 11px; color: #94a3b8; text-align: center;">
                    Sent securely via ${companyName}
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
      </html>
    `;

    const mailOptions = {
      to: targetRecipient,
      subject: emailSubject,
      html: emailHtml,
      attachments,
      settings,
    };
    if (cc && typeof cc === 'string' && cc.trim()) {
      mailOptions.cc = cc.trim();
    }

    const info = await mailService.sendMail(mailOptions);
    return res.json({
      success: true,
      message: `Document${docs.length > 1 ? 's' : ''} successfully sent to ${targetRecipient}!`,
      messageId: info.messageId,
      recipient: targetRecipient,
    });
  } catch (error) {
    console.error('Error sending company document email:', error);
    const { formatSmtpError } = require('../utils/mailService');
    const friendlyMessage = typeof formatSmtpError === 'function' ? formatSmtpError(error) : error.message;
    return res.status(400).json({
      success: false,
      message: friendlyMessage || 'Failed to send document email',
    });
  }
};
