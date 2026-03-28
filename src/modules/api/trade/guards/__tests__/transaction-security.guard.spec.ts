import { ForbiddenException } from "@nestjs/common";

import { TransactionSecurityGuard } from "../transaction-security.guard";

function makeContext(user: any, body: Record<string, unknown>) {
    return {
        switchToHttp: () => ({ getRequest: () => ({ user, body }) }),
    } as any;
}

function makePrisma() {
    return {
        user: {
            findUnique: jest.fn(),
        },
    };
}

describe("TransactionSecurityGuard", () => {
    let jwtService: { verifyAsync: jest.Mock };
    let prisma: ReturnType<typeof makePrisma>;
    let guard: TransactionSecurityGuard;

    beforeEach(() => {
        jwtService = { verifyAsync: jest.fn() };
        prisma = makePrisma();
        guard = new TransactionSecurityGuard(jwtService as any, prisma as any);
    });

    afterEach(() => jest.clearAllMocks());

    it("should reject unauthenticated requests", async () => {
        await expect(guard.canActivate(makeContext(null, {}))).rejects.toThrow("User not authenticated");
    });

    it("should require 2FA before transactions", async () => {
        prisma.user.findUnique.mockResolvedValue({
            isTwoFactorEnabled: false,
            twoFactorSecret: null,
            securityMethods: {},
        });

        await expect(guard.canActivate(makeContext({ id: 5 }, {}))).rejects.toThrow(ForbiddenException);
    });

    it("should require verification token when 2FA is enabled", async () => {
        prisma.user.findUnique.mockResolvedValue({
            isTwoFactorEnabled: true,
            twoFactorSecret: "secret",
            securityMethods: {},
        });

        await expect(
            guard.canActivate(makeContext({ id: 5 }, { amount: 1, asset: "BTC" }))
        ).rejects.toThrow(ForbiddenException);
    });

    it("should allow request with valid authenticator token bound to asset context", async () => {
        prisma.user.findUnique.mockResolvedValue({
            isTwoFactorEnabled: true,
            twoFactorSecret: "secret",
            securityMethods: {},
        });
        const contextHash = (guard as any).computeContextHash(2.5, "BTC", "bc1qdest");
        jwtService.verifyAsync.mockResolvedValue({
            userId: 5,
            type: "transaction_verification",
            method: "authenticator",
            verifiedAt: Date.now(),
            contextHash,
        });

        await expect(
            guard.canActivate(
                makeContext({ id: 5 }, { amount: 2.5, asset: "BTC", address: "bc1qdest", verificationToken: "token-1" })
            )
        ).resolves.toBe(true);
    });

    it("should reject when an enabled additional method is missing", async () => {
        prisma.user.findUnique.mockResolvedValue({
            isTwoFactorEnabled: true,
            twoFactorSecret: "secret",
            securityMethods: { sms: true },
        });
        const contextHash = (guard as any).computeContextHash(2, "BTC", "bc1qdest");
        jwtService.verifyAsync.mockResolvedValue({
            userId: 5,
            type: "transaction_verification",
            method: "authenticator",
            verifiedAt: Date.now(),
            contextHash,
        });

        await expect(
            guard.canActivate(
                makeContext({ id: 5 }, { amount: 2, currency: "BTC", recipient: "bc1qdest", verificationToken: "token-1" })
            )
        ).rejects.toThrow(ForbiddenException);
    });

    it("should reject when token context hash does not match", async () => {
        prisma.user.findUnique.mockResolvedValue({
            isTwoFactorEnabled: true,
            twoFactorSecret: "secret",
            securityMethods: {},
        });
        jwtService.verifyAsync.mockResolvedValue({
            userId: 5,
            type: "transaction_verification",
            method: "authenticator",
            verifiedAt: Date.now(),
            contextHash: "wrong-hash",
        });

        await expect(
            guard.canActivate(
                makeContext({ id: 5 }, { amount: 2, currency: "BTC", recipient: "bc1qdest", verificationToken: "token-1" })
            )
        ).rejects.toThrow(ForbiddenException);
    });
});