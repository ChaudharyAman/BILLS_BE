const axios = require('axios');
const fs = require('fs');

const BASE_URL = 'http://localhost:5000/api/auth';
const LOG_FILE = 'verification_log.txt';

const log = (msg) => {
    console.log(msg);
    fs.appendFileSync(LOG_FILE, msg + '\n');
};

const testAuth = async () => {
    fs.writeFileSync(LOG_FILE, '--- Starting Auth Verification ---\n');
    try {
        log('--- Starting Auth Verification ---');

        // 1. Register
        const username = `testuser_${Date.now()}`;
        const password = 'password123';
        log(`\n1. Testing Registration for user: ${username}`);
        
        try {
            const registerRes = await axios.post(`${BASE_URL}/register`, {
                username,
                password
            });
            log('✅ Registration Successful');
            log('Response: ' + JSON.stringify(registerRes.data));
            
            if (!registerRes.data.token) throw new Error('No token received on register');
        } catch (error) {
            log('❌ Registration Failed: ' + (error.response ? JSON.stringify(error.response.data) : error.message));
            process.exit(1);
        }

        // 2. Login
        log(`\n2. Testing Login for user: ${username}`);
        try {
            const loginRes = await axios.post(`${BASE_URL}/login`, {
                username,
                password
            });
            log('✅ Login Successful');
            log('Response: ' + JSON.stringify(loginRes.data));

            if (!loginRes.data.token) throw new Error('No token received on login');
        } catch (error) {
            log('❌ Login Failed: ' + (error.response ? JSON.stringify(error.response.data) : error.message));
            process.exit(1);
        }

        // 3. Login with wrong password
        log('\n3. Testing Login with invalid password');
        try {
            await axios.post(`${BASE_URL}/login`, {
                username,
                password: 'wrongpassword'
            });
            log('❌ Login with wrong password SHOULD have failed but succeeded');
            process.exit(1);
        } catch (error) {
            if (error.response && error.response.status === 401) {
                log('✅ Login with wrong password Failed as expected (401)');
            } else {
                log('❌ Login with wrong password Failed with unexpected error: ' + error.message);
                process.exit(1);
            }
        }

        log('\n--- Auth Verification Completed Successfully ---');

    } catch (error) {
        log('Verification Script Error: ' + error.message);
        process.exit(1);
    }
};

testAuth();
