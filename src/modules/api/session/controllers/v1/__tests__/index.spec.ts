jest.mock("@/modules/api/auth/guard", () => ({
    AuthGuard: class {
        readonly __stub = true;
    },
    __esModule: true,
}));

import { SessionController } from "../index";

describe("SessionController", () => {
    let controller: SessionController;
    let sessionService: {
        getUserSessions: jest.Mock;
        revokeSession: jest.Mock;
        revokeAllOtherSessions: jest.Mock;
        extendSession: jest.Mock;
        invalidateCurrentSession: jest.Mock;
        getActiveSessionCount: jest.Mock;
        cleanupBotSessions: jest.Mock;
    };

    const req = { user: { id: 44 } };

    beforeEach(() => {
        sessionService = {
            getUserSessions: jest.fn(),
            revokeSession: jest.fn(),
            revokeAllOtherSessions: jest.fn(),
            extendSession: jest.fn(),
            invalidateCurrentSession: jest.fn(),
            getActiveSessionCount: jest.fn(),
            cleanupBotSessions: jest.fn(),
        };

        controller = new SessionController(sessionService as never);
    });

    it("delegates get/revoke/extend/invalidate calls", async () => {
        sessionService.getUserSessions.mockResolvedValue({ success: true });
        sessionService.revokeSession.mockResolvedValue({ success: true });
        sessionService.extendSession.mockResolvedValue({ success: true });
        sessionService.invalidateCurrentSession.mockResolvedValue({ success: true });

        await expect(controller.getSessions(req as never, "sid-1")).resolves.toEqual({ success: true });
        await expect(
            controller.revokeSession(req as never, { sessionId: "sid-2" } as never, "sid-current"),
        ).resolves.toEqual({ success: true });
        await expect(controller.extendSession(req as never, { sessionId: "sid-3" } as never)).resolves.toEqual({ success: true });
        await expect(
            controller.invalidateCurrentSession(req as never, { sessionId: "sid-4" } as never),
        ).resolves.toEqual({ success: true });

        expect(sessionService.getUserSessions).toHaveBeenCalledWith(req.user, "sid-1");
        expect(sessionService.revokeSession).toHaveBeenCalledWith(req.user, "sid-2", "sid-current");
        expect(sessionService.extendSession).toHaveBeenCalledWith(req.user, "sid-3");
        expect(sessionService.invalidateCurrentSession).toHaveBeenCalledWith(req.user, "sid-4");
    });

    it("returns failure when revoke-all is missing current session id", async () => {
        await expect(controller.revokeAllSessions(req as never, "" as never)).resolves.toEqual({
            success: false,
            message: "Current session ID is required",
        });
        expect(sessionService.revokeAllOtherSessions).not.toHaveBeenCalled();
    });

    it("delegates revoke-all, count, and cleanup", async () => {
        sessionService.revokeAllOtherSessions.mockResolvedValue({ success: true });
        sessionService.getActiveSessionCount.mockResolvedValue(3);
        sessionService.cleanupBotSessions.mockResolvedValue(2);

        await expect(controller.revokeAllSessions(req as never, "sid-current")).resolves.toEqual({ success: true });
        await expect(controller.getSessionCount(req as never)).resolves.toEqual({
            success: true,
            message: "Session count retrieved",
            data: { count: 3 },
        });
        await expect(controller.cleanupBotSessions()).resolves.toEqual({
            success: true,
            message: "Cleaned up 2 bot/health-check sessions",
            data: { cleanedCount: 2 },
        });
    });
});