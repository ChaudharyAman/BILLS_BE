/**
 * utils/attachmentHelper.js
 *
 * Shared helpers for binary attachments across Invoices, Expenses, Purchase Orders, and Incomes.
 */

function processIncomingAttachments(incoming = [], existing = []) {
  if (!Array.isArray(incoming)) return existing;

  const result = [];
  const existingMap = new Map();
  for (const item of existing) {
    if (item._id) {
      existingMap.set(String(item._id), item);
    }
  }

  for (const item of incoming) {
    // 1. Existing attachment preserved by _id
    if (item._id && existingMap.has(String(item._id)) && !item.base64) {
      result.push(existingMap.get(String(item._id)));
      continue;
    }

    // 2. New attachment with base64 payload
    if (item.base64 && item.originalName) {
      const cleanBase64 = String(item.base64).replace(/^data:[^;]+;base64,/, '');
      const buf = Buffer.from(cleanBase64, 'base64');
      result.push({
        originalName: item.originalName,
        mimeType: item.mimeType || 'application/octet-stream',
        sizeBytes: buf.length,
        buffer: buf,
        uploadedAt: item.uploadedAt ? new Date(item.uploadedAt) : new Date(),
      });
      continue;
    }

    // 3. Buffer already passed directly
    if (item.buffer && item.originalName) {
      result.push(item);
    }
  }

  return result;
}

function sanitizeAttachments(attachments = []) {
  if (!Array.isArray(attachments)) return [];
  return attachments.map(att => {
    const obj = att.toObject ? att.toObject() : { ...att };
    delete obj.buffer;
    return obj;
  });
}

function streamAttachment(res, attachment) {
  if (!attachment || !attachment.buffer) {
    return res.status(404).json({ message: 'Attachment file not found' });
  }

  const filename = encodeURIComponent(attachment.originalName || 'download');
  res.setHeader('Content-Type', attachment.mimeType || 'application/octet-stream');
  res.setHeader('Content-Length', attachment.buffer.length);
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${filename}`);
  return res.end(attachment.buffer);
}

module.exports = {
  processIncomingAttachments,
  sanitizeAttachments,
  streamAttachment,
};
