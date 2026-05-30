const TDS_SECTIONS = {
  '194C': { label: 'Contractor', defaultRate: 2 },
  '194J': { label: 'Professional/Technical', defaultRate: 10 },
  '194I': { label: 'Rent', defaultRate: 10 },
  '194A': { label: 'Interest', defaultRate: 10 },
  Manual: { label: 'Manual', defaultRate: 0 },
};

function roundToTwo(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function getTdsRate(section = '194J', providedRate) {
  if (providedRate !== undefined && providedRate !== null && providedRate !== '') {
    return Math.max(0, Number(providedRate) || 0);
  }
  return TDS_SECTIONS[section]?.defaultRate ?? TDS_SECTIONS['194J'].defaultRate;
}

function calculateTds({ baseAmount = 0, section = '194J', rate } = {}) {
  const resolvedSection = TDS_SECTIONS[section] ? section : '194J';
  const resolvedRate = getTdsRate(resolvedSection, rate);
  const resolvedBase = Math.max(0, Number(baseAmount) || 0);
  const amount = roundToTwo((resolvedBase * resolvedRate) / 100);

  return {
    section: resolvedSection,
    sectionLabel: TDS_SECTIONS[resolvedSection].label,
    rate: resolvedRate,
    baseAmount: roundToTwo(resolvedBase),
    amount,
    receivable: amount,
  };
}

module.exports = {
  TDS_SECTIONS,
  calculateTds,
};
