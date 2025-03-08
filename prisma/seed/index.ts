import { Prisma, PrismaClient, UserType } from "@prisma/client";
import * as bcrypt from "bcryptjs";
const prisma = new PrismaClient();
import logger from "moment-logger";

import { roles } from "./role";

async function main() {
    // Seed roles
    for (let role of roles) {
        await prisma.role.upsert({
            where: { slug: role.slug },
            update: {},
            create: role,
        });
    }

    const businessRole = await prisma.role.findUnique({
        where: { slug: "business" } // Change the slug to match your business role
    });

    if (businessRole) {
        // Hash the password before storing it
        const plainPassword = "businesspass123"; // You can change this to any password you want
        const hashedPassword = await bcrypt.hash(plainPassword, 10);

        const createUserOptions: Prisma.UserUncheckedCreateInput = {
            email: "chidi90simeon@gmail.com",  // Updated email
            phone: "090300000023",
            userType: UserType.BUSINESS, // Set userType to BUSINESS
            identifier: "8jhPCbsdSKxBUSI2", // Different identifier for business
            password: hashedPassword, // Use the hashed password
            roleId: businessRole.id, // Use the role ID for business
            firstName: "Chidi",        // Updated first name
            lastName: "Simeon",        // Updated last name
        };

        await prisma.user.upsert({
            where: { email: createUserOptions.email },
            update: {},
            create: createUserOptions,
        });
    }
}

main()
    .then(() => {
        logger.info("Database seeding successful");
    })
    .catch((err) => {
        logger.error(`Database seeding failed ${err}`);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
