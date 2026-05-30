const mongoose = require('mongoose');
const dotenv = require('dotenv');
const Client = require('../models/Client');

dotenv.config();

const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
const GSTIN_REGEX = /^[0-9A-Z]{15}$/;

async function migrate() {
  if (!mongoUri) throw new Error('MONGO_URI or MONGODB_URI is required');

  await mongoose.connect(mongoUri);
  const clients = await Client.find({}).select('user gstin tds_default_section tds_default_rate default_tds_section default_tds_rate').lean();
  let companies = 0;
  let individuals = 0;
  let missingUser = 0;

  for (const client of clients) {
    const hasGstin = GSTIN_REGEX.test(String(client.gstin || '').trim().toUpperCase());
    const update = {};

    if (hasGstin) {
      const section = client.tds_default_section || client.default_tds_section || '194J';
      const rate = Number(client.tds_default_rate || client.default_tds_rate || 10);
      Object.assign(update, {
        clientType: 'Company',
        tds_applicable: true,
        tds_default_section: section,
        tds_default_rate: rate,
        default_tds_section: section,
        default_tds_rate: rate,
      });
      companies += 1;
    } else {
      Object.assign(update, {
        clientType: 'Individual',
        tds_applicable: false,
        tds_default_section: null,
        tds_default_rate: null,
        default_tds_section: '',
        default_tds_rate: 0,
      });
      individuals += 1;
    }

    if (!client.user) missingUser += 1;
    await Client.updateOne({ _id: client._id }, { $set: update }, { runValidators: false });
  }

  console.log(`Client type migration complete. Companies: ${companies}, individuals: ${individuals}, legacy clients without user: ${missingUser}`);
  await mongoose.disconnect();
}

migrate().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
