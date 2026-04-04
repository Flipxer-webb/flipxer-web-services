
import axios from 'axios';
import { authenticator } from 'otplib';

// Configuration
const API_URL = 'https://resolve-api-dev.onrender.com/api/v1';
const EMAIL = 'business_test_check_limits_prod_verify@yjo4y7so.mailosaur.net';
const PASSWORD = 'Password123!';
const TOTP_SECRET = 'OAJC6YQPGFZR22YI';

async function main() {
    console.log(`1. Logging in as ${EMAIL}...`);

    try {
        // Step 1: Login
        const loginRes = await axios.post(`${API_URL}/auth/login`, {
            email: EMAIL,
            password: PASSWORD
        });

        const tempToken = loginRes.data.data.token; // Usually a temp token for 2FA
        console.log('   Login successful. 2FA required.');

        // Step 2: Generate TOTP
        const token = authenticator.generate(TOTP_SECRET);
        console.log(`2. Generated TOTP: ${token}`);

        // Step 3: Verify 2FA
        const verifyRes = await axios.post(`${API_URL}/auth/verify-2fa-login`, {
            code: token
        }, {
            headers: { Authorization: `Bearer ${tempToken}` }
        });

        const accessToken = verifyRes.data.data.token;
        console.log('   2FA verified. Access token obtained.');

        // Step 4: Get Profile
        console.log('3. Fetching User Profile...');
        const profileRes = await axios.get(`${API_URL}/user/profile`, {
            headers: { Authorization: `Bearer ${accessToken}` }
        });

        const profile = profileRes.data.data;
        console.log('---------------------------------------------------');
        console.log(`User Type: ${profile.userType}`);
        console.log(`Tier: ${profile.tier}`);
        console.log(`Business Record Completed: ${profile.businessRecordCompleted}`);
        console.log(`Business Docs Uploaded: ${profile.businessDocumentsUploaded}`);
        console.log('---------------------------------------------------');
        console.log('VERIFICATION REQUIREMENTS:');
        console.log(JSON.stringify(profile.verificationRequirements, null, 2));
        console.log('---------------------------------------------------');

        // Validation
        if (profile.verificationRequirements &&
            (profile.verificationRequirements.nextStep === 'BUSINESS_RECORD' ||
                profile.verificationRequirements.nextStep === 'BUSINESS_DOCUMENT_UPLOAD')) {
            console.log('✅ PASS: Business flow requirements present.');
        } else {
            console.log('❌ FAIL: Incorrect or missing verification requirements.');
        }

    } catch (error: any) {
        if (error.response) {
            console.error('❌ Error Status:', error.response.status);
            console.error('❌ Error Data:', JSON.stringify(error.response.data, null, 2));
            console.error('❌ Error Headers:', JSON.stringify(error.response.headers, null, 2));
        } else if (error.request) {
            console.error('❌ Error Request:', error.request);
        } else {
            console.error('❌ Error Message:', error.message);
        }
    }
}

main();
