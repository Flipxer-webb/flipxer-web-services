/**
 * Debug Quidax API access
 */
import * as dotenv from "dotenv";
import axios from "axios";

dotenv.config();

const QUIDAX_API_URL = process.env.QUIDAX_BASE_URL || "https://www.quidax.com/api/v1";
const QUIDAX_SECRET_KEY = process.env.QUIDAX_API_SECRET;

const sanitizeForLog = (value: unknown): string =>
    String(value).replaceAll(/[\r\n\t]/g, " ");

console.log("=== Quidax API Debug ===\n");
console.log(`API URL: ${QUIDAX_API_URL}`);
console.log(`API Key configured: ${QUIDAX_SECRET_KEY ? "yes" : "no"}\n`);

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
            console.log(
                `  ✅ ${response.status} - response received (${sanitizeForLog(JSON.stringify(response.data)).length} chars)\n`
            );
        } catch (error: any) {
            console.log(
                `  ❌ ${error.response?.status || "ERR"} - ${sanitizeForLog(error.message)}\n`
            );
        }
    }
}

testEndpoints();
