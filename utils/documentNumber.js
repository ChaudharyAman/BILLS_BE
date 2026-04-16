const normalizePrefix = (prefix, fallback) => {
  const value = String(prefix || fallback || '').trim().replace(/[-/\s]+$/g, '');
  return value || fallback || 'DOC';
};

const buildAutoDocumentNumber = (prefix, seq) => {
  const normalizedPrefix = normalizePrefix(prefix, 'DOC');
  return `${normalizedPrefix}-${String(seq).padStart(3, '0')}`;
};

const buildCustomDocumentNumber = ({ prefix, explicitNumber, docNo, docNoSuffix }) => {
  const explicit = String(explicitNumber || '').trim();
  if (explicit && explicit !== 'Auto-generated') {
    return explicit;
  }

  const main = String(docNo || '').trim();
  if (!main) {
    return null;
  }

  const suffix = String(docNoSuffix || '').trim();
  const normalizedPrefix = normalizePrefix(prefix, 'DOC');
  return `${normalizedPrefix}-${main}${suffix ? `-${suffix}` : ''}`;
};

module.exports = {
  normalizePrefix,
  buildAutoDocumentNumber,
  buildCustomDocumentNumber,
};
