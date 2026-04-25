/**
 * Script to create a Tier 1 test user directly in the database
 * 
 * Tier 1 requirements:
 * - isEmailVerified: true
 * - isPhoneVerified: true
 * - isBvnVerified: true
 * - isDocumentVerified: true
 * 
 * Usage: npx ts-node scripts/create-tier1-test-user.ts
 */

import { PrismaClient, UserType } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { authenticator } from 'otplib';
import { v4 as uuidv4 } from 'uuid';

const prisma = new PrismaClient();

function resolveTier1TestPassword() {
    return process.env.TIER1_TEST_PASSWORD || uuidv4();
}

async function main() {
    const timestamp = Math.floor(Date.now() / 1000);
    const email = `tier1-test-${timestamp}@yjo4y7so.mailosaur.net`;
    const userPassword = resolveTier1TestPassword();
    const passwordSource = process.env.TIER1_TEST_PASSWORD
        ? 'TIER1_TEST_PASSWORD'
        : 'generated in memory';
    const hashedPassword = await bcrypt.hash(userPassword, 10);
    const twoFactorSecret = authenticator.generateSecret();
    const identifier = uuidv4();

    console.log('Creating Tier 1 test user...');
    console.log('Email:', email);
    console.log('Password source:', passwordSource);
    console.log('2FA Secret:', twoFactorSecret);

    // Get the default Individual role
    const userRole = await prisma.role.findFirst({
        where: { name: 'Individual' },
    });

    if (!userRole) {
        throw new Error('Individual role not found in database. Please seed roles first.');
    }

    // Check if user already exists
    const existingUser = await prisma.user.findUnique({
        where: { email },
    });

    if (existingUser) {
        console.log('User already exists, updating...');
        const updatedUser = await prisma.user.update({
            where: { email },
            data: {
                isEmailVerified: true,
                isPhoneVerified: true,
                isBvnVerified: true,
                isDocumentVerified: true,
                isTwoFactorEnabled: true,
                twoFactorSecret,
                tier: 1,
            },
        });
        console.log('User updated:', updatedUser.id);
        return;
    }

    // Create new user with Tier 1 verification status
    const user = await prisma.user.create({
        data: {
            identifier,
            email,
            password: hashedPassword,
            firstName: 'TierOne',
            lastName: 'TestUser',
            phone: `+234${Math.floor(Math.random() * 9000000000) + 1000000000}`,
            dateOfBirth: new Date('1990-01-15'),
            
            // Account settings
            userType: UserType.INDIVIDUAL,
            roleId: userRole.id,
            
            // Verification flags for Tier 1
            isEmailVerified: true,
            isPhoneVerified: true,
            isBvnVerified: true,
            isDocumentVerified: true,
            isPasswordCreated: true,
            
            // Additional flags (not required for Tier 1)
            isAddressVerified: false,
            isBiometricVerified: false,
            isIncomeVerified: false,
            
            // 2FA enabled
            isTwoFactorEnabled: true,
            twoFactorSecret,
            
            // Set tier directly
            tier: 1,
            
            // BVN data (mock)
            bvn: '22211100000',
        },
    });

    console.log('\n✅ Tier 1 test user created successfully!');
    console.log('----------------------------------------');
    console.log('User ID:', user.id);
    console.log('Email:', email);
    console.log('Password source:', passwordSource);
    console.log('2FA Secret:', twoFactorSecret);
    console.log('Tier:', 1);
    console.log('----------------------------------------');
    console.log('\nTo generate a 2FA code, run:');
    console.log(`node -e "const { authenticator } = require('otplib'); console.log(authenticator.generate('${twoFactorSecret}'));"`);
}

main()
    .catch((error) => {
        console.error('Error creating user:', error);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
