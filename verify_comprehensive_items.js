const axios = require('axios');

const API_URL = 'http://localhost:5000/api/items';

async function verify() {
  try {
    console.log('--- Starting Comprehensive Verification ---');

    // 1. Create Product Item (Goods)
    console.log('1. Creating Product Item...');
    const productItem = {
      name: 'Gaming Mouse',
      type: 'Goods',
      unit: 'pcs',
      sku: 'GM-001',
      openingQuantity: 50,
      defaultTaxRate: 18,
      salesInfo: {
        price: 2500,
        currency: 'INR',
        cessPercent: 0,
        cessAmount: 0
      },
      purchaseInfo: {
        price: 1800,
        currency: 'INR',
        cessPercent: 0,
        cessAmount: 0
      }
    };
    const res1 = await axios.post(API_URL, productItem);
    console.log('   Success! Created:', res1.data.name);
    console.log('   SKU:', res1.data.sku);
    console.log('   Sales Price:', res1.data.salesInfo?.price);

    // 2. Create Service Item
    console.log('2. Creating Service Item...');
    const serviceItem = {
      name: 'Web Development',
      type: 'Service',
      unit: 'hr',
      hsnCode: '998311', // SAC
      defaultTaxRate: 18,
      salesInfo: {
        price: 1500,
        currency: 'INR',
        cessPercent: 0,
        cessAmount: 0
      },
      // Service might not have purchase info usually, but schema allows it
    };
    const res2 = await axios.post(API_URL, serviceItem);
    console.log('   Success! Created:', res2.data.name);
    console.log('   SAC:', res2.data.hsnCode);
    console.log('   Sales Price:', res2.data.salesInfo?.price);

    // 3. Verify List
    console.log('3. Verifying List...');
    const res3 = await axios.get(API_URL);
    const items = res3.data;
    
    // Check if items exist
    const foundProduct = items.find(i => i.sku === 'GM-001');
    const foundService = items.find(i => i.name === 'Web Development');

    if (foundProduct && foundService) {
      if(foundProduct.openingQuantity === 50 && foundProduct.salesInfo.price === 2500) {
         console.log('--- Verification PASSED ---');
         console.log('Valid Product Data Found');
      } else {
         console.error('--- Verification FAILED: Product Data Mismatch ---');
      }
    } else {
      console.error('--- Verification FAILED: Items not found ---');
      process.exit(1);
    }

  } catch (error) {
    console.error('Error during verification:', error.response ? error.response.data : error.message);
    process.exit(1);
  }
}

verify();
