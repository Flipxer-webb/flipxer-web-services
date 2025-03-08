import { Prisma } from "@prisma/client";

export const roles: Prisma.RoleUncheckedCreateInput[] = [
    {
        name: "Individual",
        slug: "individual",
        isAdmin: false,
    },
    {
        name: "Business",
        slug: "business",
        isAdmin: false,
    },
    //admins
    {
        name: "Super Admin",
        slug: "super-admin",
        isAdmin: true,
    },
];
