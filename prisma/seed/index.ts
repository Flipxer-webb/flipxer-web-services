import { Prisma, PrismaClient, UserType } from "@prisma/client";
const prisma = new PrismaClient();
import logger from "moment-logger";

import { roles } from "./role";

async function main() {
    for (let role of roles) {
        await prisma.role.upsert({
            where: { slug: role.slug },
            update: {},
            create: role,
        });
    }

    const adminRole = await prisma.role.findUnique({where:{slug:"super-admin"}})
    
    if(adminRole){
        const createUserOptions: Prisma.UserUncheckedCreateInput = {
            email: "admin@resolve.com",
            phone: "09030000000",
            userType: UserType.ADMIN,
            identifier: "8jhPCbsdSKxKwfgi",
            password:
                "$2a$10$DX04Gh3Y2NM9Z1AvDJI.P.XOOfj6Aoqm0tEYvOSI5DVRVuA2Ic5mS", //pass123
            roleId: 1,
            firstName: "resolve",
            lastName: "Admin",
        };
        await prisma.user.upsert({
            where:{email:createUserOptions.email},
            update:{},
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
