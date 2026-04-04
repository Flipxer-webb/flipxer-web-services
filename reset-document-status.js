require('dotenv').config();

// Remove quotes from DATABASE_URL if present
if (process.env.DATABASE_URL && process.env.DATABASE_URL.startsWith('"')) {
  process.env.DATABASE_URL = process.env.DATABASE_URL.replace(/^"|"$/g, '');
}

// Use DIRECT_DATABASE_URL if available (bypasses connection pooling)
if (process.env.DIRECT_DATABASE_URL) {
  let directUrl = process.env.DIRECT_DATABASE_URL;
  if (directUrl.startsWith('"')) {
    directUrl = directUrl.replace(/^"|"$/g, '');
  }
  process.env.DATABASE_URL = directUrl;
}

const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: process.env.DATABASE_URL
    }
  }
});

async function resetDocumentStatus() {
  const email = "magpiep18@gmail.com";
  
  try {
    // Find the user
    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true, firstName: true, lastName: true, isDocumentVerified: true }
    });

    if (!user) {
      console.log(`User with email ${email} not found`);
      return;
    }

    console.log(`Found user: ${user.firstName} ${user.lastName} (ID: ${user.id})`);
    console.log(`Current document verified status: ${user.isDocumentVerified}`);

    // Check existing document
    const existingDoc = await prisma.userDocument.findUnique({
      where: { userId: user.id },
      select: { verificationStatus: true, type: true, createdAt: true }
    });

    if (existingDoc) {
      console.log(`Existing document: type=${existingDoc.type}, status=${existingDoc.verificationStatus}`);
      
      // Delete the document record
      await prisma.userDocument.delete({
        where: { userId: user.id }
      });
      console.log("Deleted existing document record");
    } else {
      console.log("No existing document found");
    }

    // Reset user's document verified flag
    await prisma.user.update({
      where: { id: user.id },
      data: { isDocumentVerified: false }
    });
    console.log("Reset user.isDocumentVerified to false");

    console.log("\n✅ Document verification status reset successfully!");
    console.log("User can now submit a new document for verification.");

  } catch (error) {
    console.error("Error:", error.message);
  } finally {
    await prisma.$disconnect();
  }
}

resetDocumentStatus();
