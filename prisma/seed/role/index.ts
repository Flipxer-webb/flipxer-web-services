import { Prisma } from "@prisma/client";

export const roles: Prisma.RoleUncheckedCreateInput[] = [
    {
        name: "Customer",
        slug: "customer",
        isAdmin: false,
    },
    {
        name: "Business",
        slug: "Business",
        isAdmin: false,
    },
    //admins
    {
        name: "Super Admin",
        slug: "super-admin",
        isAdmin: true,
    },
];
