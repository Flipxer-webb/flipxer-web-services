import { NotFoundException, UnauthorizedException } from "@nestjs/common";

jest.mock("bcryptjs", () => ({
    compare: jest.fn(),
}));

import * as bcrypt from "bcryptjs";
import { UserService } from "../user.service";

describe("UserService", () => {
    const loginCredential = "auth-code";
    const invalidCredential = "invalid-auth-code";
    const buildMockHash = () => ["mock", "hashed", "credential"].join("-");

    const prisma = {
        user: {
            findUnique: jest.fn(),
            update: jest.fn(),
        },
    };

    let service: UserService;

    beforeEach(() => {
        jest.clearAllMocks();
        service = new UserService(prisma as any);
    });

    it("throws NotFoundException when user is missing", async () => {
        prisma.user.findUnique.mockResolvedValue(null);

        await expect(service.validateUser("missing@test.com", loginCredential)).rejects.toBeInstanceOf(NotFoundException);
    });

    it("throws UnauthorizedException for inactive users", async () => {
        prisma.user.findUnique.mockResolvedValue({
            id: 1,
            email: "blocked@test.com",
            status: "BLOCKED",
            password: buildMockHash(),
            loginCount: 0,
            role: { id: 1 },
        });

        await expect(service.validateUser("blocked@test.com", loginCredential)).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it("throws UnauthorizedException for invalid credentials", async () => {
        prisma.user.findUnique.mockResolvedValue({
            id: 2,
            email: "user@test.com",
            status: "ACTIVE",
            password: buildMockHash(),
            loginCount: 1,
            role: { id: 2 },
        });
        (bcrypt.compare as jest.Mock).mockResolvedValue(false);

        await expect(service.validateUser("user@test.com", invalidCredential)).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it("updates login metadata and returns user without password", async () => {
        prisma.user.findUnique.mockResolvedValue({
            id: 3,
            email: "ok@test.com",
            status: "ACTIVE",
            password: buildMockHash(),
            loginCount: 4,
            role: { id: 3 },
            firstName: "Ok",
        });
        (bcrypt.compare as jest.Mock).mockResolvedValue(true);
        prisma.user.update.mockResolvedValue({});

        const result = await service.validateUser("ok@test.com", loginCredential);

        expect(prisma.user.update).toHaveBeenCalledWith({
            where: { id: 3 },
            data: { lastLogin: expect.any(Date), loginCount: 5 },
        });
        expect(result).toEqual({
            id: 3,
            email: "ok@test.com",
            status: "ACTIVE",
            loginCount: 4,
            role: { id: 3 },
            firstName: "Ok",
        });
        expect((result as any).password).toBeUndefined();
    });

    it("delegates getUserByEmail to prisma", async () => {
        prisma.user.findUnique.mockResolvedValue({ id: 9, email: "test@test.com" });

        const result = await service.getUserByEmail("test@test.com");

        expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { email: "test@test.com" } });
        expect(result).toEqual({ id: 9, email: "test@test.com" });
    });
});
