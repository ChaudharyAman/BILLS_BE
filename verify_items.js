const axios = require('axios');

const API_URL = 'http://localhost:5000/api/items';

async function verify() {
  try {
    console.log('--- Starting Verification ---');

    // 1. Create Service Item
    console.log('1. Creating Service Item...');
    const serviceItem = {
      name: 'Consultation Service',
      type: 'Service',
      unit: 'hr',
      rate: 500,
      taxRate: 18
    };
    const res1 = await axios.post(API_URL, serviceItem);
    console.log('   Success! Created:', res1.data.name, 'Type:', res1.data.type);

    // 2. Create Goods Item
    console.log('2. Creating Goods Item...');
    const goodsItem = {
      name: 'Physical Widget',
      type: 'Goods',
      unit: 'pcs',
      rate: 100,
      taxRate: 18
    };
    const res2 = await axios.post(API_URL, goodsItem);
    console.log('   Success! Created:', res2.data.name, 'Type:', res2.data.type);

    // 3. Verify List
    console.log('3. Verifying List...');
    const res3 = await axios.get(API_URL);
    const items = res3.data;
    
    // Check if items exist
    const foundService = items.find(i => i.name === 'Consultation Service' && i.type === 'Service');
    const foundGoods = items.find(i => i.name === 'Physical Widget' && i.type === 'Goods');

    if (foundService && foundGoods) {
      console.log('--- Verification PASSED ---');
      console.log('Found Service Item:', foundService.name);
      console.log('Found Goods Item:', foundGoods.name);
    } else {
      console.error('--- Verification FAILED ---');
      if (!foundService) console.log('Missing Service Item');
      if (!foundGoods) console.log('Missing Goods Item');
      process.exit(1);
    }

  } catch (error) {
    console.error('Error during verification:', error.response ? error.response.data : error.message);
    process.exit(1);
  }
}

verify();
