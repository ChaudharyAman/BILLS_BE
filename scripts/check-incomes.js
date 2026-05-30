const path = require('path');
const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const Income = require('../models/Income');

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  
  const statuses = await Income.aggregate([
    { $group: { _id: { status: '$status', sourceType: '$sourceType' }, count: { $sum: 1 } } },
    { $sort: { '_id.sourceType': 1, '_id.status': 1 } }
  ]);
  
  console.log('\n=== Income Status Breakdown ===');
  statuses.forEach(s => {
    console.log(`  [${s._id.sourceType || 'manual'}] ${s._id.status}: ${s.count}`);
  });

  // Show any UNPAID ones
  const unpaid = await Income.find({ status: { $in: ['UNPAID', 'SENT', 'OVERDUE'] } })
    .select('incomeNumber status sourceType grandTotal date')
    .lean();
  
  if (unpaid.length > 0) {
    console.log('\n=== UNPAID Income Records ===');
    unpaid.forEach(i => {
      console.log(`  ${i.incomeNumber} | ${i.status} | ${i.sourceType} | ₹${i.grandTotal} | ${i.date}`);
    });
  } else {
    console.log('\nNo UNPAID income records found.');
  }
  
  await mongoose.disconnect();
})();
