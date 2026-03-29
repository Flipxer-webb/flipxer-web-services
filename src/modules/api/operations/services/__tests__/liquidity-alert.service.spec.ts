import { LiquidityAlertService } from "../liquidity-alert.service";

describe("LiquidityAlertService", () => {
    const prisma = {
        liquidityAlert: {
            create: jest.fn(),
            findMany: jest.fn(),
            count: jest.fn(),
            groupBy: jest.fn(),
            update: jest.fn(),
            findFirst: jest.fn(),
        },
    };

    const slackService = {
        sendAlert: jest.fn(),
    };

    const walletService = {
        checkLiquidityThresholds: jest.fn(),
    };

    let service: LiquidityAlertService;

    beforeEach(() => {
        jest.clearAllMocks();
        service = new LiquidityAlertService(
            prisma as any,
            slackService as any,
            walletService as any
        );
    });

    it("creates alert and sends Slack notification", async () => {
        prisma.liquidityAlert.create.mockResolvedValue({
            id: 1,
            currency: "BTC",
            alertType: "LOW_BALANCE",
        });
        slackService.sendAlert.mockResolvedValue({ sent: 1 });

        const result = await service.createAlert({
            currency: "btc",
            alertType: "LOW_BALANCE",
            threshold: 0.5,
            currentValue: 0.3,
        });

        expect(prisma.liquidityAlert.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    currency: "BTC",
                    status: "PENDING",
                }),
            })
        );
        expect(slackService.sendAlert).toHaveBeenCalled();
        expect(result.id).toBe(1);
    });

    it("gets alerts with filters and pagination", async () => {
        prisma.liquidityAlert.findMany.mockResolvedValue([{ id: 1 }, { id: 2 }]);
        prisma.liquidityAlert.count.mockResolvedValue(5);

        const result = await service.getAlerts({
            status: "PENDING",
            currency: "eth",
            alertType: "HIGH_BALANCE",
            page: 2,
            limit: 2,
        });

        expect(prisma.liquidityAlert.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    status: "PENDING",
                    currency: "ETH",
                    alertType: "HIGH_BALANCE",
                }),
                skip: 2,
                take: 2,
            })
        );
        expect(result.pagination.total).toBe(5);
        expect(result.pagination.totalPages).toBe(3);
    });

    it("builds pending alert summary by type and status", async () => {
        prisma.liquidityAlert.groupBy.mockResolvedValue([
            { alertType: "LOW_BALANCE", status: "PENDING", _count: 2 },
            { alertType: "LOW_BALANCE", status: "ESCALATED", _count: 1 },
        ]);

        const summary = await service.getPendingAlertsSummary();

        expect(summary).toEqual({
            LOW_BALANCE: { pending: 2, escalated: 1 },
        });
    });

    it("acknowledges and resolves alerts", async () => {
        prisma.liquidityAlert.update
            .mockResolvedValueOnce({ id: 2, status: "ACKNOWLEDGED" })
            .mockResolvedValueOnce({ id: 2, status: "RESOLVED" });

        const acknowledged = await service.acknowledgeAlert(2, 44);
        const resolved = await service.resolveAlert(2, 44, { note: "Handled" });

        expect(acknowledged.status).toBe("ACKNOWLEDGED");
        expect(resolved.status).toBe("RESOLVED");
    });

    it("escalates alert and sends non-cooldown notification", async () => {
        prisma.liquidityAlert.update.mockResolvedValue({
            id: 3,
            currency: "BTC",
            alertType: "LOW_BALANCE",
            threshold: 0.1,
        });
        slackService.sendAlert.mockResolvedValue({ sent: 1 });

        const result = await service.escalateAlert(3);

        expect(result.id).toBe(3);
        expect(slackService.sendAlert).toHaveBeenCalledWith(
            "ESCALATED",
            expect.any(Object),
            { respectCooldown: false }
        );
    });

    it("creates alerts only for new breaches during runLiquidityCheck", async () => {
        walletService.checkLiquidityThresholds.mockResolvedValue({
            breaches: [
                {
                    wallet: { currency: "btc", availableBalance: "0.2" },
                    threshold: { minBalance: 0.5, maxBalance: 10 },
                    breachType: "low",
                },
                {
                    wallet: { currency: "eth", availableBalance: "20" },
                    threshold: { minBalance: 1, maxBalance: 10 },
                    breachType: "high",
                },
            ],
        });
        prisma.liquidityAlert.findFirst
            .mockResolvedValueOnce({ id: 11 })
            .mockResolvedValueOnce(null);

        const createAlertSpy = jest
            .spyOn(service, "createAlert")
            .mockResolvedValue({ id: 99 } as any);

        const result = await service.runLiquidityCheck();

        expect(result).toEqual({ newAlerts: 1, existingAlerts: 1 });
        expect(createAlertSpy).toHaveBeenCalledTimes(1);
    });

    it("returns alert statistics grouped by status/type/currency", async () => {
        prisma.liquidityAlert.count.mockResolvedValue(7);
        prisma.liquidityAlert.groupBy
            .mockResolvedValueOnce([
                { status: "PENDING", _count: 3 },
                { status: "RESOLVED", _count: 4 },
            ])
            .mockResolvedValueOnce([
                { currency: "BTC", _count: 4 },
                { currency: "ETH", _count: 3 },
            ])
            .mockResolvedValueOnce([
                { alertType: "LOW_BALANCE", _count: 5 },
                { alertType: "HIGH_BALANCE", _count: 2 },
            ]);

        const result = await service.getAlertStatistics(15);

        expect(result.totalAlerts).toBe(7);
        expect(result.byStatus).toEqual({ PENDING: 3, RESOLVED: 4 });
        expect(result.byCurrency[0]).toEqual({ currency: "BTC", count: 4 });
        expect(result.byType).toEqual({ LOW_BALANCE: 5, HIGH_BALANCE: 2 });
    });
});