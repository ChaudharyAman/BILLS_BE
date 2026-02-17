const axios = require('axios');

const API_URL = 'http://localhost:5000/api/auth';

const testAuth = async () => {
  try {
    const username = `testuser_${Date.now()}`;
    const password = 'password123';

    console.log('Testing Registration...');
    const registerRes = await axios.post(`${API_URL}/register`, {
      username,
      password
    });
    console.log('Register Success:', registerRes.status === 201);
    console.log('Token received:', !!registerRes.data.token);

    console.log('\nTesting Login...');
    const loginRes = await axios.post(`${API_URL}/login`, {
      username,
      password
    });
    console.log('Login Success:', loginRes.status === 200);
    console.log('Token received:', !!loginRes.data.token);

  } catch (error) {
    console.error('Test Failed:', error.response ? error.response.data : error.message);
  }
};

testAuth();
