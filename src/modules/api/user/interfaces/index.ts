import { Prisma } from "@prisma/client";

export interface ClientDataInterface {
    ipAddress: string;
}

export type UserWithRoles = Prisma.UserGetPayload<{
    include: {
        role: {
            select: { name: true; slug: true };
        };
    };
}>;
