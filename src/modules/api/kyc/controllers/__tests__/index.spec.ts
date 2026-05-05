import { UnauthorizedException } from "@nestjs/common";

import { Permissions } from "@/modules/api/authorize/decorator";
import { PermissionName } from "@/modules/api/authorize/enums/role";
import { KycController } from "../index";

describe("KycController", () => {
    let controller: KycController;
    let kycService: {
        getKycQueue: jest.Mock;
        getKycStats: jest.Mock;
        getKycUserDetail: jest.Mock;
        runProviderLookup: jest.Mock;
        runAttemptVerificationLookup: jest.Mock;
        processKycDecision: jest.Mock;
        processAttemptDecision: jest.Mock;
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
            runProviderLookup: jest.fn(),
            runAttemptVerificationLookup: jest.fn(),
            processKycDecision: jest.fn(),
            processAttemptDecision: jest.fn(),
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
            controller.runKycProviderLookup({ userId: 7, verificationType: "DOCUMENT" } as never, req as never),
        ).rejects.toBeInstanceOf(UnauthorizedException);
        await expect(
            controller.approveKycDecision({ userId: 7, verificationType: "DOCUMENT" } as never, req as never),
        ).rejects.toBeInstanceOf(UnauthorizedException);
        await expect(
            controller.processAttemptDecision(19, { action: "APPROVE", expectedVersion: 3 } as never, req as never),
        ).rejects.toBeInstanceOf(UnauthorizedException);
        await expect(
            controller.rejectKycDecision({ userId: 7, verificationType: "DOCUMENT" } as never, req as never),
        ).rejects.toBeInstanceOf(UnauthorizedException);
        await expect(
            controller.escalateKycDecision({ userId: 7, verificationType: "DOCUMENT" } as never, req as never),
        ).rejects.toBeInstanceOf(UnauthorizedException);
        await expect(
            controller.runAttemptRecheck(19, { provider: "DOJAH" } as never, req as never),
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
        const lookupDto = { userId: 10, verificationType: "DOCUMENT" };
        const attemptLookupDto = { provider: "DOJAH" };
        const approveDecision = { userId: 10, verificationType: "DOCUMENT", version: 3 };
        const attemptDecision = { action: "APPROVE", expectedVersion: 3, note: "clear" };
        const rejectDecision = { userId: 10, verificationType: "DOCUMENT", version: 3, note: "blurred" };
        const escalateDecision = { userId: 10, verificationType: "DOCUMENT", version: 3, note: "needs escalation" };
        const tierDto = { tier: 3 };
        const verificationDto = { bvnVerified: true };
        const approveDto = { userId: 10, documentType: "address", version: 2 };
        const rejectDto = { userId: 10, documentType: "address", reason: "blurred", version: 2 };

        kycService.runProviderLookup.mockResolvedValue({ ok: true });
        kycService.runAttemptVerificationLookup.mockResolvedValue({ ok: true });
        kycService.processKycDecision.mockResolvedValue({ ok: true });
        kycService.processAttemptDecision.mockResolvedValue({ ok: true });
        kycService.updateUserTier.mockResolvedValue({ ok: true });
        kycService.updateUserVerification.mockResolvedValue({ ok: true });
        kycService.approveDocument.mockResolvedValue({ ok: true });
        kycService.rejectDocument.mockResolvedValue({ ok: true });

        await controller.runKycProviderLookup(lookupDto as never, req as never);
        await controller.runAttemptRecheck(17, attemptLookupDto as never, req as never);
        await controller.approveKycDecision(approveDecision as never, req as never);
        await controller.processAttemptDecision(17, attemptDecision as never, req as never);
        await controller.rejectKycDecision(rejectDecision as never, req as never);
        await controller.escalateKycDecision(escalateDecision as never, req as never);
        await controller.updateUserTier(10, tierDto as never, req as never);
        await controller.updateUserVerification(10, verificationDto as never, req as never);
        await controller.approveDocument(approveDto as never, req as never);
        await controller.rejectDocument(rejectDto as never, req as never);

        expect(kycService.runProviderLookup).toHaveBeenCalledWith(lookupDto, 55);
        expect(kycService.runAttemptVerificationLookup).toHaveBeenCalledWith(17, attemptLookupDto, 55);
        expect(kycService.processKycDecision).toHaveBeenNthCalledWith(1, { ...approveDecision, action: "APPROVE" }, 55);
        expect(kycService.processAttemptDecision).toHaveBeenCalledWith(17, attemptDecision, 55);
        expect(kycService.processKycDecision).toHaveBeenNthCalledWith(2, { ...rejectDecision, action: "REJECT" }, 55);
        expect(kycService.processKycDecision).toHaveBeenNthCalledWith(3, { ...escalateDecision, action: "ESCALATE" }, 55);
        expect(kycService.updateUserTier).toHaveBeenCalledWith(10, tierDto, 55);
        expect(kycService.updateUserVerification).toHaveBeenCalledWith(10, verificationDto, 55);
        expect(kycService.approveDocument).toHaveBeenCalledWith(approveDto, 55);
        expect(kycService.rejectDocument).toHaveBeenCalledWith(rejectDto, 55);
    });

    it("protects provider lookups with KYC_APPROVE permission", () => {
        const permissions = Reflect.getMetadata(Permissions.KEY, KycController.prototype.runKycProviderLookup);

        expect(permissions).toEqual([PermissionName.KYC_APPROVE]);
    });
});
