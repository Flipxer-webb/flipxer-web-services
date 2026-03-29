import { UnauthorizedException } from "@nestjs/common";

import { KycController } from "../index";

describe("KycController", () => {
    let controller: KycController;
    let kycService: {
        getKycQueue: jest.Mock;
        getKycStats: jest.Mock;
        getKycUserDetail: jest.Mock;
        processKycDecision: jest.Mock;
        updateUserTier: jest.Mock;
        updateUserVerification: jest.Mock;
        approveDocument: jest.Mock;
        rejectDocument: jest.Mock;
    };

    beforeEach(() => {
        kycService = {
            getKycQueue: jest.fn(),
            getKycStats: jest.fn(),
            getKycUserDetail: jest.fn(),
            processKycDecision: jest.fn(),
            updateUserTier: jest.fn(),
            updateUserVerification: jest.fn(),
            approveDocument: jest.fn(),
            rejectDocument: jest.fn(),
        };

        controller = new KycController(kycService as never);
    });

    it("delegates read endpoints", async () => {
        const queueDto = { status: "PENDING" };
        const statsDto = { period: "7d" };

        kycService.getKycQueue.mockResolvedValue({ items: [] });
        kycService.getKycStats.mockResolvedValue({ approved: 10 });
        kycService.getKycUserDetail.mockResolvedValue({ id: 17 });

        await expect(controller.getKycQueue(queueDto as never)).resolves.toEqual({ items: [] });
        await expect(controller.getKycStats(statsDto as never)).resolves.toEqual({ approved: 10 });
        await expect(controller.getKycUserDetail(17)).resolves.toEqual({ id: 17 });

        expect(kycService.getKycQueue).toHaveBeenCalledWith(queueDto);
        expect(kycService.getKycStats).toHaveBeenCalledWith(statsDto);
        expect(kycService.getKycUserDetail).toHaveBeenCalledWith(17);
    });

    it("throws UnauthorizedException when admin id is missing", async () => {
        const req = { user: {} };

        await expect(
            controller.processKycDecision({ action: "approve" } as never, req as never),
        ).rejects.toBeInstanceOf(UnauthorizedException);
        await expect(
            controller.updateUserTier(7, { tier: 2 } as never, req as never),
        ).rejects.toBeInstanceOf(UnauthorizedException);
        await expect(
            controller.updateUserVerification(7, { bvnVerified: true } as never, req as never),
        ).rejects.toBeInstanceOf(UnauthorizedException);
        await expect(
            controller.approveDocument({ userId: 8 } as never, req as never),
        ).rejects.toBeInstanceOf(UnauthorizedException);
        await expect(
            controller.rejectDocument({ userId: 8 } as never, req as never),
        ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it("delegates write endpoints when admin id exists", async () => {
        const req = { user: { id: 55 } };
        const decision = { action: "approve", userId: 10 };
        const tierDto = { tier: 3 };
        const verificationDto = { bvnVerified: true };
        const approveDto = { userId: 10, type: "address" };
        const rejectDto = { userId: 10, reason: "blurred" };

        kycService.processKycDecision.mockResolvedValue({ ok: true });
        kycService.updateUserTier.mockResolvedValue({ ok: true });
        kycService.updateUserVerification.mockResolvedValue({ ok: true });
        kycService.approveDocument.mockResolvedValue({ ok: true });
        kycService.rejectDocument.mockResolvedValue({ ok: true });

        await controller.processKycDecision(decision as never, req as never);
        await controller.updateUserTier(10, tierDto as never, req as never);
        await controller.updateUserVerification(10, verificationDto as never, req as never);
        await controller.approveDocument(approveDto as never, req as never);
        await controller.rejectDocument(rejectDto as never, req as never);

        expect(kycService.processKycDecision).toHaveBeenCalledWith(decision, 55);
        expect(kycService.updateUserTier).toHaveBeenCalledWith(10, tierDto, 55);
        expect(kycService.updateUserVerification).toHaveBeenCalledWith(10, verificationDto, 55);
        expect(kycService.approveDocument).toHaveBeenCalledWith(approveDto, 55);
        expect(kycService.rejectDocument).toHaveBeenCalledWith(rejectDto, 55);
    });
});
