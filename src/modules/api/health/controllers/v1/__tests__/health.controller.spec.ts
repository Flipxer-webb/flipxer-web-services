import { HttpStatus } from "@nestjs/common";
import { HealthController } from "../index";

describe("HealthController", () => {
    let controller: HealthController;
    let prisma: { isHealthy: jest.Mock };
    let redis: { isHealthy: jest.Mock; getStats: jest.Mock };

    const mockResponse = () => {
        const res = {
            status: jest.fn(),
            json: jest.fn(),
        } as any;
        res.status.mockReturnValue(res);
        res.json.mockReturnValue(res);
        return res;
    };

    beforeEach(() => {
        prisma = { isHealthy: jest.fn() };
        redis = {
            isHealthy: jest.fn(),
            getStats: jest.fn(),
        };

        controller = new HealthController(prisma as any, redis as any);
    });

    it("should return healthy status when database is healthy", async () => {
        prisma.isHealthy.mockResolvedValue(true);
        redis.isHealthy.mockResolvedValue({ healthy: true, usingFallback: false, latencyMs: 2 });
        redis.getStats.mockReturnValue({ fallbackSize: 0 });

        const res = mockResponse();
        await controller.check(res);

        expect(res.status).toHaveBeenCalledWith(HttpStatus.OK);
        expect(res.json).toHaveBeenCalledWith(
            expect.objectContaining({
                success: true,
                message: "OK",
                services: expect.objectContaining({
                    database: expect.objectContaining({ healthy: true }),
                    redis: expect.objectContaining({ healthy: true, fallbackSize: 0 }),
                }),
            }),
        );
    });

    it("should return degraded status when database is unhealthy", async () => {
        prisma.isHealthy.mockResolvedValue(false);
        redis.isHealthy.mockResolvedValue({ healthy: true, usingFallback: false, latencyMs: 1 });
        redis.getStats.mockReturnValue({ fallbackSize: 0 });

        const res = mockResponse();
        await controller.check(res);

        expect(res.status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
        expect(res.json).toHaveBeenCalledWith(
            expect.objectContaining({ success: false, message: "DEGRADED" }),
        );
    });

    it("should handle database and redis check errors", async () => {
        prisma.isHealthy.mockRejectedValue(new Error("db down"));
        redis.isHealthy.mockRejectedValue(new Error("redis down"));

        const res = mockResponse();
        await controller.check(res);

        expect(res.status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
        expect(res.json).toHaveBeenCalledWith(
            expect.objectContaining({
                services: {
                    database: { healthy: false, error: "db down" },
                    redis: { healthy: false, usingFallback: true, error: "redis down" },
                },
            }),
        );
    });

    it("should respond ready=true when database is healthy", async () => {
        prisma.isHealthy.mockResolvedValue(true);

        const res = mockResponse();
        await controller.ready(res);

        expect(res.status).toHaveBeenCalledWith(HttpStatus.OK);
        expect(res.json).toHaveBeenCalledWith({ ready: true });
    });

    it("should respond ready=false when database is not healthy", async () => {
        prisma.isHealthy.mockResolvedValue(false);

        const res = mockResponse();
        await controller.ready(res);

        expect(res.status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
        expect(res.json).toHaveBeenCalledWith({ ready: false, reason: "database" });
    });

    it("should handle readiness check exceptions", async () => {
        prisma.isHealthy.mockRejectedValue(new Error("db unavailable"));

        const res = mockResponse();
        await controller.ready(res);

        expect(res.status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
        expect(res.json).toHaveBeenCalledWith({ ready: false, reason: "db unavailable" });
    });

    it("should return ping and live payloads", () => {
        expect(controller.ping()).toEqual(
            expect.objectContaining({ pong: true, timestamp: expect.any(Number) }),
        );
        expect(controller.live()).toEqual(
            expect.objectContaining({ alive: true, timestamp: expect.any(Number) }),
        );
    });

    it("should format uptime correctly", () => {
        const formatted = (controller as any).formatUptime(90061);
        expect(formatted).toBe("1d 1h 1m 1s");
    });
});
