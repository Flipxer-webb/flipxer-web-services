/**
 * Debug Quidax API access
 */
import * as dotenv from "dotenv";
import axios from "axios";

dotenv.config();

const QUIDAX_API_URL = process.env.QUIDAX_BASE_URL || "https://www.quidax.com/api/v1";
const QUIDAX_SECRET_KEY = process.env.QUIDAX_API_SECRET;

console.log("=== Quidax API Debug ===\n");
console.log(`API URL: ${QUIDAX_API_URL}`);
console.log(`API Key: ${QUIDAX_SECRET_KEY ? QUIDAX_SECRET_KEY.slice(0, 10) + "..." : "NOT SET"}\n`);

async function testEndpoints() {
    const endpoints = [
        "/users/me",
        "/users/me/wallets",
        "/wallets",
        "/account",
    ];

    for (const endpoint of endpoints) {
        try {
            console.log(`Testing: ${endpoint}...`);
            const response = await axios.get(`${QUIDAX_API_URL}${endpoint}`, {
                headers: {
                    Authorization: `Bearer ${QUIDAX_SECRET_KEY}`,
                },
            });
            console.log(`  ✅ ${response.status} - ${JSON.stringify(response.data).slice(0, 100)}...\n`);
        } catch (error: any) {
            console.log(`  ❌ ${error.response?.status || "ERR"} - ${error.message}\n`);
        }
    }
}

testEndpoints();
