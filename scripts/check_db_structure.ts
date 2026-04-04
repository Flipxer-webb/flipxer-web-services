
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    try {
        // Check if UserBiometricCredential table exists
        const tableCheck = await prisma.$queryRaw`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public'
        AND table_name = 'UserBiometricCredential'
      );
    `;
        console.log('UserBiometricCredential Table Exists:', tableCheck);

        // Check if isBiometricVerified column exists in User table (Users in DB)
        const columnCheck = await prisma.$queryRaw`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'Users' 
      AND column_name = 'isBiometricVerified';
    `;
        console.log('isBiometricVerified Column:', columnCheck);

        // Check if biometricVerifiedAt column exists in User table
        const columnCheck2 = await prisma.$queryRaw`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'Users' 
      AND column_name = 'biometricVerifiedAt';
    `;
        console.log('biometricVerifiedAt Column:', columnCheck2);

    } catch (error) {
        console.error('Error querying database structure:', error);
    } finally {
        await prisma.$disconnect();
    }
}

main();
