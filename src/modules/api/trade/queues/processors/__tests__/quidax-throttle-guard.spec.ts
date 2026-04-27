import { Logger } from "@nestjs/common";
import { isQuidaxThrottlingError, withQuidaxThrottleGuard } from "../quidax-throttle-guard";
import { QuidaxTooManyRequestError } from "@/libs/quidax";
import { QuidaxException } from "@/modules/factory/trading/providers/quidax/errors";

describe("isQuidaxThrottlingError", () => {
    it("returns false for null/undefined", () => {
        expect(isQuidaxThrottlingError(null)).toBe(false);
        expect(isQuidaxThrottlingError(undefined)).toBe(false);
    });

    it("detects QuidaxTooManyRequestError instances", () => {
        expect(isQuidaxThrottlingError(new QuidaxTooManyRequestError("rate limit"))).toBe(true);
    });

    it("detects QuidaxException with status 429", () => {
        expect(isQuidaxThrottlingError(new QuidaxException("too many", 429))).toBe(true);
    });

    it("detects QuidaxException with status 444", () => {
        expect(isQuidaxThrottlingError(new QuidaxException("throttled", 444))).toBe(true);
    });

    it("returns false for QuidaxException with non-throttle status", () => {
        expect(isQuidaxThrottlingError(new QuidaxException("boom", 500))).toBe(false);
    });

    it("falls back to plain object status field", () => {
        expect(isQuidaxThrottlingError({ status: 429 })).toBe(true);
        expect(isQuidaxThrottlingError({ status: 444 })).toBe(true);
        expect(isQuidaxThrottlingError({ status: 500 })).toBe(false);
        expect(isQuidaxThrottlingError({})).toBe(false);
    });

    it("returns false for unrelated errors", () => {
        expect(isQuidaxThrottlingError(new Error("boom"))).toBe(false);
        expect(isQuidaxThrottlingError("string")).toBe(false);
    });
});

describe("withQuidaxThrottleGuard", () => {
    let logger: Logger;
    let queue: {
        isPaused: jest.Mock;
        pause: jest.Mock;
        resume: jest.Mock;
        name: string;
    };

    beforeEach(() => {
        logger = new Logger("test");
        jest.spyOn(logger, "warn").mockImplementation(() => undefined);
        jest.spyOn(logger, "log").mockImplementation(() => undefined);
        jest.spyOn(logger, "error").mockImplementation(() => undefined);

        queue = {
            isPaused: jest.fn().mockResolvedValue(false),
            pause: jest.fn().mockResolvedValue(undefined),
            resume: jest.fn().mockResolvedValue(undefined),
            name: "test-queue",
        };
    });

    it("returns the handler value on success", async () => {
        const handler = jest.fn().mockResolvedValue("ok");
        const result = await withQuidaxThrottleGuard(queue as never, logger, handler);

        expect(result).toBe("ok");
        expect(queue.pause).not.toHaveBeenCalled();
    });

    it("re-throws non-throttle errors without pausing", async () => {
        const err = new Error("boom");
        const handler = jest.fn().mockRejectedValue(err);

        await expect(
            withQuidaxThrottleGuard(queue as never, logger, handler),
        ).rejects.toBe(err);

        expect(queue.pause).not.toHaveBeenCalled();
    });

    it("pauses the queue and re-throws on a throttling error", async () => {
        const err = new QuidaxTooManyRequestError("rate limited");
        const handler = jest.fn().mockRejectedValue(err);

        await expect(
            withQuidaxThrottleGuard(queue as never, logger, handler, 5_000),
        ).rejects.toBe(err);

        expect(queue.pause).toHaveBeenCalledWith(true);
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining("Pausing queue"),
        );
    });

    it("schedules a resume after the cooldown window", async () => {
        const err = new QuidaxTooManyRequestError("rate limited");
        const handler = jest.fn().mockRejectedValue(err);

        await expect(
            withQuidaxThrottleGuard(queue as never, logger, handler, 5),
        ).rejects.toBe(err);

        // Wait just past the 5ms cooldown using real timers so we don't
        // collide with any global fake-timer setup in the jest environment.
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(queue.resume).toHaveBeenCalledWith(true);
    });

    it("skips pausing if the queue is already paused", async () => {
        queue.isPaused.mockResolvedValue(true);
        const err = new QuidaxTooManyRequestError("rate limited");
        const handler = jest.fn().mockRejectedValue(err);

        await expect(
            withQuidaxThrottleGuard(queue as never, logger, handler),
        ).rejects.toBe(err);

        expect(queue.pause).not.toHaveBeenCalled();
    });

    it("never masks the original error if pausing throws", async () => {
        queue.isPaused.mockRejectedValue(new Error("redis down"));
        const original = new QuidaxTooManyRequestError("rate limited");
        const handler = jest.fn().mockRejectedValue(original);

        await expect(
            withQuidaxThrottleGuard(queue as never, logger, handler),
        ).rejects.toBe(original);

        expect(logger.error).toHaveBeenCalledWith(
            expect.stringContaining("Failed to pause queue"),
        );
    });
});
