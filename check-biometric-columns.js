const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function checkBiometricColumns() {
    console.log('🔍 Checking biometric columns in database...\n');
    
    try {
        const result = await prisma.$queryRaw`
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = 'Users' 
            AND column_name IN ('biometricCredentialId', 'biometricPublicKey', 'biometricVerifiedAt')
            ORDER BY column_name;
        `;
        
        console.log('📊 Biometric Columns:');
        if (result.length === 0) {
            console.log('❌ No biometric columns found!');
        } else {
            result.forEach(col => {
                console.log(`  ✅ ${col.column_name}: ${col.data_type}`);
            });
        }
        
    } catch (error) {
        console.error('❌ Error:', error.message);
    } finally {
        await prisma.$disconnect();
    }
}

checkBiometricColumns();
