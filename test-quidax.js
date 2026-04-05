// Quick test script to verify Quidax API connection
require('dotenv').config();
const axios = require('axios');

const QUIDAX_BASE_URL = process.env.QUIDAX_BASE_URL;
const QUIDAX_API_SECRET = process.env.QUIDAX_API_SECRET;
const QUIDAX_API_PUBLIC = process.env.QUIDAX_API_PUBLIC;

console.log('=== Quidax API Configuration Test ===');
console.log('QUIDAX_BASE_URL:', QUIDAX_BASE_URL || 'NOT SET');
console.log('QUIDAX_API_PUBLIC:', QUIDAX_API_PUBLIC ? `${QUIDAX_API_PUBLIC.substring(0, 10)}...` : 'NOT SET');
console.log('QUIDAX_API_SECRET:', QUIDAX_API_SECRET ? `${QUIDAX_API_SECRET.substring(0, 10)}...` : 'NOT SET');
console.log('');

if (!QUIDAX_BASE_URL || !QUIDAX_API_SECRET) {
    console.error('ERROR: Missing required Quidax configuration!');
    process.exit(1);
}

async function testQuidaxConnection() {
    try {
        // Test 1: Get account details (me endpoint)
        console.log('Test 1: Testing Quidax API authentication...');
        const meResponse = await axios.get(`${QUIDAX_BASE_URL}/users/me`, {
            headers: {
                'Authorization': `Bearer ${QUIDAX_API_SECRET}`,
            }
        });
        console.log('✓ Authentication successful!');
        console.log('  Account:', meResponse.data?.data?.email || 'N/A');
        console.log('');
        
        // Test 2: List sub-accounts
        console.log('Test 2: Listing sub-accounts...');
        const subAccountsResponse = await axios.get(`${QUIDAX_BASE_URL}/users`, {
            headers: {
                'Authorization': `Bearer ${QUIDAX_API_SECRET}`,
            }
        });
        console.log('✓ Sub-accounts retrieved!');
        console.log('  Count:', subAccountsResponse.data?.data?.length || 0);
        console.log('');
        
        // Test 3: Try to create a test sub-account
        console.log('Test 3: Testing sub-account creation (dry run)...');
        const testEmail = `test-${Date.now()}@flipxer.test`;
        try {
            const createResponse = await axios.post(`${QUIDAX_BASE_URL}/users`, {
                email: testEmail,
                first_name: 'Test',
                last_name: 'User',
            }, {
                headers: {
                    'Authorization': `Bearer ${QUIDAX_API_SECRET}`,
                }
            });
            console.log('✓ Sub-account creation works!');
            console.log('  Created ID:', createResponse.data?.data?.id);
        } catch (createError) {
            console.log('✗ Sub-account creation failed:');
            console.log('  Status:', createError.response?.status);
            console.log('  Message:', createError.response?.data?.message || createError.message);
        }
        
        console.log('\n=== Test Complete ===');
        
    } catch (error) {
        console.error('✗ Quidax API Error:');
        console.error('  Status:', error.response?.status);
        console.error('  Message:', error.response?.data?.message || error.message);
        console.error('  Full response:', JSON.stringify(error.response?.data, null, 2));
    }
}

testQuidaxConnection();
