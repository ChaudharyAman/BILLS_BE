/**
 * Central Industry Extensions Registry (Backend)
 * 
 * Provides modular, plug-and-play industry schemas and extensions.
 * To add another industry (e.g. Healthcare, Retail, Manufacturing),
 * create a new folder under `MBB/industries/<industryName>/` and register it below.
 */

const logistics = require('./logistics');

const INDUSTRIES = {
  [logistics.id.toLowerCase()]: logistics,
};

const getIndustry = (idOrName) => {
  if (!idOrName || typeof idOrName !== 'string') return null;
  return INDUSTRIES[idOrName.trim().toLowerCase()] || null;
};

const getAllIndustries = () => Object.values(INDUSTRIES);

module.exports = {
  INDUSTRIES,
  getIndustry,
  getAllIndustries,
  logistics,
};
