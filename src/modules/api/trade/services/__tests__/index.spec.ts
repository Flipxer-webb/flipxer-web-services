import { ForbiddenException } from "@nestjs/common";
import { EntryStatus, OrderCategory, OrderStatus } from "@prisma/client";

// Break circular dependency chain (auth/guards -> user module) for isolated service tests
jest.mock("@/modules/api/user", () => ({
    User: () => () => {},
    ClientData: () => () => {},
    UserModule: class { readonly __stub = true },
    AccountDeletedException: class extends Error {},
    UserNotFoundException: class extends Error {},
    __esModule: true,
}));

import { TradingService } from "..";
import {
    GeneralTransactionException,
    OutOfRangeException,
    TransactionNotFoundException,
    UnknownFeeStructureException,
} from "../../errors";

function makeDeps() {
    const prisma = {
        user: {
            findUnique: jest.fn(),
            update: jest.fn(),
        },
        order: {
            findFirst: jest.fn(),
            findMany: jest.fn(),
            update: jest.fn(),
            create: jest.fn(),
            findUnique: jest.fn(),
        },
        notification: {
            create: jest.fn(),
            findMany: jest.fn(),
        },
        assetWallet: {
            findUnique: jest.fn(),
            update: jest.fn(),
            upsert: jest.fn(),
            findMany: jest.fn(),
        },
        cryptoWalletAddress: {
            findUnique: jest.fn(),
            findFirst: jest.fn(),
            findMany: jest.fn(),
            update: jest.fn(),
        },
        ledgerEntry: {
            findFirst: jest.fn(),
        },
        withdrawalQueue: {
            updateMany: jest.fn(),
        },
        $transaction: jest.fn(),
    };

    const prismaTx = {
        order: { create: jest.fn(), update: jest.fn() },
        payment: { update: jest.fn() },
    };

    prisma.$transaction.mockImplementation(async (arg: any) => {
        if (typeof arg === "function") {
            return arg(prismaTx);
        }
        return Promise.all(arg);
    });

    const quidaxService = {
        getPaymentMethods: jest.fn(),
        getPurchaseLimitForBuy: jest.fn(),
        getSingleMarketTicker: jest.fn(),
        getWithdrawerDetail: jest.fn(),
        cancelWithdrawerRequest: jest.fn(),
        getPaymentAddressById: jest.fn(),
        getUserWallet: jest.fn(),
        getUserWalletList: jest.fn(),
        createPaymentAddress: jest.fn(),
        createInstantSwapRequest: jest.fn(),
        confirmInstantSwap: jest.fn(),
        getSwapTransaction: jest.fn(),
        getWithdrawerByReference: jest.fn(),
        createOrFindSubAccount: jest.fn(),
        fetchDeposits: jest.fn(),
    };

    const wsGateway = {
        notifyTransactionUpdate: jest.fn(),
        notifyWalletUpdate: jest.fn(),
        notifyUser: jest.fn(),
    };

    const tradeHelpers = {
        safeJsonStringify: jest.fn((p) => JSON.stringify(p)),
        normalizeNetworkInput: jest.fn((n: string) => n?.toLowerCase()),
    };

    const walletAddressService = {
        syncWallet: jest.fn().mockResolvedValue(undefined),
        extractDepositEnabledNetworkMap: jest.fn(),
        ensureWalletPaymentAddresses: jest.fn(),
        getWalletAddress: jest.fn(),
        getWalletAddresses: jest.fn(),
        verifyWalletAddress: jest.fn(),
        initiateWalletAddressCreation: jest.fn(),
    };

    const buyOrderService = {
        buyCryptoQuoteRequest: jest.fn(),
        buyCryptoOrder: jest.fn(),
        confirmPaymentSent: jest.fn(),
        getBuyOrderStatus: jest.fn(),
        cancelBuyOrder: jest.fn(),
        notifyPendingBuyOrder: jest.fn(),
        calculateBuyQuote: jest.fn(),
        executeInternalBuy: jest.fn(),
    };

    const sellOrderService = {
        sellCryptoQuoteRequest: jest.fn(),
        sellCryptoOrder: jest.fn(),
        calculateSellQuote: jest.fn(),
    };

    const swapService = {
        createInstantSwap: jest.fn(),
        refreshInstantSwap: jest.fn(),
        confirmInstantSwapQuote: jest.fn(),
    };

    const sendService = {
        withdrawerRequest: jest.fn(),
        cancelWithdrawerRequest: jest.fn(),
        getCryptoWithdrawerFee: jest.fn(),
    };

    const ledgerService = {
        releaseHold: jest.fn(),
    };

    const sweepService = {
        handleSweepConfirmation: jest.fn(),
    };

    const webhookHandlerService = {
        depositHandler: jest.fn(),
        swapTransactionHandler: jest.fn(),
        withdrawerTransactionHandler: jest.fn(),
    };

    const liveCoinWatchService = {
        getMarketData: jest.fn(),
        getHistoricalData: jest.fn(),
        getBatchSparklines: jest.fn(),
    };

    const coinCapService = {
        getBatchMarketData: jest.fn(),
        getHistoricalData: jest.fn(),
        getBatchSparklines: jest.fn(),
    };

    const coinGeckoService = {};
    const cryptoAccountQueueProducer = {};
    const notificationMessage = {};
    const walletManagementService = {};
    const lockService = {};

    const service = new TradingService(
        prisma as any,
        quidaxService as any,
        cryptoAccountQueueProducer as any,
        notificationMessage as any,
        wsGateway as any,
        coinGeckoService as any,
        liveCoinWatchService as any,
        coinCapService as any,
        walletManagementService as any,
        lockService as any,
        tradeHelpers as any,
        walletAddressService as any,
        buyOrderService as any,
        sellOrderService as any,
        swapService as any,
        sendService as any,
        ledgerService as any,
        sweepService as any,
        webhookHandlerService as any,
    );

    return {
        service,
        prisma,
        quidaxService,
        wsGateway,
        walletAddressService,
        buyOrderService,
        sellOrderService,
        swapService,
        sendService,
        ledgerService,
        sweepService,
        webhookHandlerService,
        liveCoinWatchService,
        coinCapService,
    };
}

function pendingOrder(overrides: Record<string, unknown> = {}) {
    return {
        id: 1,
        userId: 10,
        status: OrderStatus.processing,
        streamlinedStatus: "pending",
        orderCategory: OrderCategory.BUY,
        providerOrderId: "provider-1",
        orderReference: "order-ref-1",
        ledgerEntryId: "ledger-1",
        amount: 100,
        currency: "BTC",
        transactionId: "TX-1",
        createdAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
        ...overrides,
    };
}

describe("TradingService (index)", () => {
    afterEach(() => jest.clearAllMocks());

    describe("simple response helpers", () => {
        it("getSupportedAssets returns a non-empty list", () => {
            const { service } = makeDeps();
            const res = service.getSupportedAssets();
            expect(Array.isArray(res.data)).toBe(true);
            expect(res.data.length).toBeGreaterThan(0);
        });

        it("getSupportedNetworks returns a non-empty list", () => {
            const { service } = makeDeps();
            const res = service.getSupportedNetworks();
            expect(Array.isArray(res.data)).toBe(true);
            expect(res.data.length).toBeGreaterThan(0);
        });

        it("getSupportedTradingPairs returns a non-empty list", () => {
            const { service } = makeDeps();
            const res = service.getSupportedTradingPairs();
            expect(Array.isArray(res.data)).toBe(true);
            expect(res.data.length).toBeGreaterThan(0);
        });
    });

    describe("password-change cooldown", () => {
        it("buyCryptoOrder blocks during cooldown", async () => {
            const { service, prisma, buyOrderService } = makeDeps();
            prisma.user.findUnique.mockResolvedValue({ passwordChangedAt: new Date() });

            await expect(
                service.buyCryptoOrder({ id: 10 } as any, { amount: 1 } as any),
            ).rejects.toBeInstanceOf(ForbiddenException);
            expect(buyOrderService.buyCryptoOrder).not.toHaveBeenCalled();
        });

        it("buyCryptoOrder delegates after cooldown expires", async () => {
            const { service, prisma, buyOrderService } = makeDeps();
            prisma.user.findUnique.mockResolvedValue({
                passwordChangedAt: new Date(Date.now() - 7 * 60 * 60 * 1000),
            });
            buyOrderService.buyCryptoOrder.mockResolvedValue({ ok: true });

            const res = await service.buyCryptoOrder(
                { id: 10 } as any,
                { amount: 1 } as any,
            );

            expect(res).toEqual({ ok: true });
            expect(buyOrderService.buyCryptoOrder).toHaveBeenCalled();
        });
    });

    describe("delegations", () => {
        it("depositHandler delegates to webhook handler", async () => {
            const { service, webhookHandlerService } = makeDeps();
            webhookHandlerService.depositHandler.mockResolvedValue({ ok: 1 });

            const res = await service.depositHandler({ ref: "a" } as any);

            expect(res).toEqual({ ok: 1 });
            expect(webhookHandlerService.depositHandler).toHaveBeenCalled();
        });

        it("swapTransactionHandler delegates to webhook handler", async () => {
            const { service, webhookHandlerService } = makeDeps();
            webhookHandlerService.swapTransactionHandler.mockResolvedValue({ ok: 1 });

            const res = await service.swapTransactionHandler({ id: "s" } as any);

            expect(res).toEqual({ ok: 1 });
            expect(webhookHandlerService.swapTransactionHandler).toHaveBeenCalled();
        });

        it("withdrawerTransactionHandler delegates to webhook handler", async () => {
            const { service, webhookHandlerService } = makeDeps();
            webhookHandlerService.withdrawerTransactionHandler.mockResolvedValue({ ok: 1 });

            const res = await service.withdrawerTransactionHandler({ id: "w" } as any);

            expect(res).toEqual({ ok: 1 });
            expect(webhookHandlerService.withdrawerTransactionHandler).toHaveBeenCalled();
        });

        it("handleSweepConfirmation delegates to sweep service", async () => {
            const { service, sweepService } = makeDeps();
            sweepService.handleSweepConfirmation.mockResolvedValue({ ok: true });

            const res = await service.handleSweepConfirmation("tx-1", "completed");

            expect(res).toEqual({ ok: true });
            expect(sweepService.handleSweepConfirmation).toHaveBeenCalledWith(
                "tx-1",
                "completed",
                undefined,
            );
        });

        it("getGeneratedWalletAddress delegates to quidax service", async () => {
            const { service, quidaxService } = makeDeps();
            quidaxService.getPaymentAddressById.mockResolvedValue({ data: { id: "p1" } });

            const res = await service.getGeneratedWalletAddress({ id: "p1" } as any);

            expect(res).toEqual({ data: { id: "p1" } });
            expect(quidaxService.getPaymentAddressById).toHaveBeenCalled();
        });

        it("getSwapEstimate maps quoted_price from swap quote", async () => {
            const { service, swapService } = makeDeps();
            swapService.createInstantSwap.mockResolvedValue({
                data: { quoted_price: 12.5, id: "q1", from_amount: "1" },
            });

            const res = await service.getSwapEstimate(
                { id: 10 } as any,
                { from_amount: 1, from_currency: "btc", to_currency: "eth" } as any,
            );

            expect(res.data.quoted_price).toBe(12.5);
            expect(res.data.id).toBe("q1");
        });

        it("delegates lightweight wrapper methods to provider/services", async () => {
            const {
                service,
                quidaxService,
                walletAddressService,
                buyOrderService,
                sellOrderService,
                swapService,
                sendService,
            } = makeDeps();

            quidaxService.getPaymentMethods.mockResolvedValue({ data: ["bank_transfer"] });
            quidaxService.getPurchaseLimitForBuy.mockResolvedValue({ data: { min: 10, max: 1000 } });
            walletAddressService.ensureWalletPaymentAddresses.mockResolvedValue([{ id: "addr-1" }]);
            walletAddressService.getWalletAddress.mockResolvedValue({ id: "w-1" });
            walletAddressService.getWalletAddresses.mockResolvedValue([{ id: "w-1" }, { id: "w-2" }]);
            walletAddressService.verifyWalletAddress.mockResolvedValue({ data: { valid: true } });
            walletAddressService.initiateWalletAddressCreation.mockResolvedValue({ message: "queued" });

            buyOrderService.buyCryptoQuoteRequest.mockResolvedValue({ data: { quote: true } });
            sellOrderService.sellCryptoQuoteRequest.mockResolvedValue({ data: { quote: true } });
            buyOrderService.confirmPaymentSent.mockResolvedValue({ data: { confirmed: true } });
            buyOrderService.getBuyOrderStatus.mockResolvedValue({ data: { status: "pending" } });
            buyOrderService.cancelBuyOrder.mockResolvedValue({ data: { cancelled: true } });
            buyOrderService.notifyPendingBuyOrder.mockResolvedValue({ data: {} });
            sellOrderService.sellCryptoOrder.mockResolvedValue({ data: { orderId: 2 } });
            buyOrderService.calculateBuyQuote.mockResolvedValue({ buyRate: 100 });
            sellOrderService.calculateSellQuote.mockResolvedValue({ sellRate: 90 });

            swapService.createInstantSwap.mockResolvedValue({ data: { id: "swap-1" } });
            swapService.refreshInstantSwap.mockResolvedValue({ data: { id: "swap-1", refreshed: true } });
            swapService.confirmInstantSwapQuote.mockResolvedValue({ data: { confirmed: true } });

            sendService.withdrawerRequest.mockResolvedValue({ data: { queued: false } });
            sendService.cancelWithdrawerRequest.mockResolvedValue({ data: { cancelled: true } });
            sendService.getCryptoWithdrawerFee.mockResolvedValue({ data: { totalFee: 0.1 } });

            await expect(service.getSupportedPaymentMethod({} as any)).resolves.toMatchObject({
                data: ["bank_transfer"],
            });
            await expect(service.getPurchaseLimitForBuy({} as any)).resolves.toMatchObject({
                data: { min: 10, max: 1000 },
            });

            await expect(
                service.ensureWalletPaymentAddresses({
                    userId: 10,
                    cryptoSubAccountId: "sub-1",
                    assetSymbol: "BTC",
                }),
            ).resolves.toEqual([{ id: "addr-1" }]);
            await expect(service.getWalletAddress(10, {} as any)).resolves.toEqual({ id: "w-1" });
            await expect(service.getWalletAddresses(10, {} as any)).resolves.toEqual([
                { id: "w-1" },
                { id: "w-2" },
            ]);
            await expect(service.verifyWalletAddress({} as any)).resolves.toEqual({ data: { valid: true } });
            await expect(service.initiateWalletAddressCreation(10, {} as any)).resolves.toEqual({ message: "queued" });

            await expect(service.buyCryptoQuoteRequest({ id: 10 } as any, {} as any)).resolves.toEqual({
                data: { quote: true },
            });
            await expect(service.sellCryptoQuoteRequest({ id: 10 } as any, {} as any)).resolves.toEqual({
                data: { quote: true },
            });
            await expect(service.confirmPaymentSent("ref-1", 10)).resolves.toEqual({
                data: { confirmed: true },
            });
            await expect(service.getBuyOrderStatus("ref-1", 10)).resolves.toEqual({
                data: { status: "pending" },
            });
            await expect(service.cancelBuyOrder("ref-1", 10)).resolves.toEqual({
                data: { cancelled: true },
            });
            await expect(service.notifyPendingBuyOrder("ref-1", 10)).resolves.toEqual({
                data: {},
            });
            await expect(service.sellCryptoOrder({ id: 10 } as any, {} as any)).resolves.toEqual({
                data: { orderId: 2 },
            });
            await expect(service.calculateBuyQuote({ id: 10 } as any, {} as any)).resolves.toEqual({
                buyRate: 100,
            });
            await expect(service.calculateSellQuote({ id: 10 } as any, {} as any)).resolves.toEqual({
                sellRate: 90,
            });

            await expect(service.createInstantSwap({ id: 10 } as any, {} as any)).resolves.toEqual({
                data: { id: "swap-1" },
            });
            await expect(service.refreshInstantSwap({ id: 10 } as any, {} as any)).resolves.toEqual({
                data: { id: "swap-1", refreshed: true },
            });
            await expect(service.confirmInstantSwapQuote({ id: 10 } as any, {} as any)).resolves.toEqual({
                data: { confirmed: true },
            });

            await expect(service.withdrawerRequest({ id: 10 } as any, {} as any)).resolves.toEqual({
                data: { queued: false },
            });
            await expect(service.cancelWithdrawerRequest({ id: 10 } as any, {} as any)).resolves.toEqual({
                data: { cancelled: true },
            });
            await expect(service.getCryptoWithdrawerFee({} as any)).resolves.toEqual({
                data: { totalFee: 0.1 },
            });

            expect(quidaxService.getPaymentMethods).toHaveBeenCalled();
            expect(quidaxService.getPurchaseLimitForBuy).toHaveBeenCalled();
            expect(walletAddressService.ensureWalletPaymentAddresses).toHaveBeenCalled();
            expect(swapService.confirmInstantSwapQuote).toHaveBeenCalled();
            expect(sendService.getCryptoWithdrawerFee).toHaveBeenCalled();
        });

        it("delegates provider-facing helper methods", async () => {
            const { service, quidaxService, prisma } = makeDeps();

            quidaxService.getSwapTransaction.mockResolvedValue({ data: { id: "swap-ref" } });
            quidaxService.getWithdrawerByReference.mockResolvedValue({ data: { id: "wd-ref" } });
            quidaxService.createOrFindSubAccount.mockResolvedValue({ status: "success", data: { id: "sub-1" } });

            prisma.assetWallet.findMany.mockResolvedValue([
                { assetCurrency: "BTC", addressSynced: true },
                { assetCurrency: "ETH", addressSynced: true },
                { assetCurrency: "USDT", addressSynced: true },
                { assetCurrency: "USDC", addressSynced: true },
                { assetCurrency: "BNB", addressSynced: true },
                { assetCurrency: "SOL", addressSynced: true },
                { assetCurrency: "XRP", addressSynced: true },
                { assetCurrency: "ADA", addressSynced: true },
                { assetCurrency: "DOGE", addressSynced: true },
                { assetCurrency: "LTC", addressSynced: true },
                { assetCurrency: "TRX", addressSynced: true },
                { assetCurrency: "SHIB", addressSynced: true },
            ]);

            await expect(service.verifySwapQuoteTransaction("swap-ref", "user-sub-1")).resolves.toEqual({
                data: { id: "swap-ref" },
            });
            await expect(
                service.getWithdrawerTransactionByReference("wd-ref", "user-sub-1"),
            ).resolves.toEqual({
                data: { id: "wd-ref" },
            });
            await expect(
                service.triggerQuidaxAccountCreation({ id: 10, email: "user@example.com" } as any),
            ).resolves.toMatchObject({
                message: expect.stringContaining("account already fully set up"),
            });
        });
    });

    describe("cancelOrder", () => {
        const user = { id: 10, cryptoSubAccountId: "sub-1" } as any;

        it("throws TransactionNotFoundException when order is missing", async () => {
            const { service, prisma } = makeDeps();
            prisma.order.findFirst.mockResolvedValue(null);

            await expect(service.cancelOrder(user, 1)).rejects.toBeInstanceOf(
                TransactionNotFoundException,
            );
        });

        it("throws when order is not pending/processing", async () => {
            const { service, prisma } = makeDeps();
            prisma.order.findFirst.mockResolvedValue(
                pendingOrder({ streamlinedStatus: "completed", status: OrderStatus.done }),
            );

            await expect(service.cancelOrder(user, 1)).rejects.toBeInstanceOf(
                GeneralTransactionException,
            );
        });

        it("cancels SEND order and releases hold", async () => {
            const { service, prisma, quidaxService, ledgerService, wsGateway, walletAddressService } = makeDeps();
            prisma.order.findFirst.mockResolvedValue(
                pendingOrder({ orderCategory: OrderCategory.SEND }),
            );
            quidaxService.getWithdrawerDetail.mockResolvedValue({ data: { status: "pending" } });
            quidaxService.cancelWithdrawerRequest.mockResolvedValue({ data: { ok: true } });
            ledgerService.releaseHold.mockResolvedValue({ success: true });
            prisma.order.update.mockResolvedValue(
                pendingOrder({ orderCategory: OrderCategory.SEND, status: OrderStatus.cancelled, streamlinedStatus: "cancelled" }),
            );

            const res = await service.cancelOrder(user, 1);

            expect(quidaxService.cancelWithdrawerRequest).toHaveBeenCalled();
            expect(ledgerService.releaseHold).toHaveBeenCalledWith(
                "withdrawal:order-ref-1",
                false,
                expect.stringContaining("cancelled SEND order"),
            );
            expect(prisma.order.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({ status: OrderStatus.cancelled }),
                }),
            );
            expect(walletAddressService.syncWallet).toHaveBeenCalled();
            expect(wsGateway.notifyWalletUpdate).toHaveBeenCalled();
            expect(res.data.streamlinedStatus).toBe("cancelled");
        });

        it("throws when SEND provider status is done/completed", async () => {
            const { service, prisma, quidaxService } = makeDeps();
            prisma.order.findFirst.mockResolvedValue(
                pendingOrder({ orderCategory: OrderCategory.SEND }),
            );
            quidaxService.getWithdrawerDetail.mockResolvedValue({ data: { status: "done" } });
            prisma.order.update.mockResolvedValue(
                pendingOrder({ status: OrderStatus.done, streamlinedStatus: "completed" }),
            );

            await expect(service.cancelOrder(user, 1)).rejects.toBeInstanceOf(
                GeneralTransactionException,
            );
        });

        it("throws when SEND hold release fails and hold is still active", async () => {
            const { service, prisma, quidaxService, ledgerService } = makeDeps();
            prisma.order.findFirst.mockResolvedValue(
                pendingOrder({ orderCategory: OrderCategory.SEND }),
            );
            quidaxService.getWithdrawerDetail.mockResolvedValue({ data: { status: "pending" } });
            quidaxService.cancelWithdrawerRequest.mockResolvedValue({ data: { ok: true } });
            ledgerService.releaseHold.mockResolvedValue({ success: false, error: "release failed" });
            prisma.ledgerEntry.findFirst.mockResolvedValue({ id: "h1", status: EntryStatus.HOLD });

            await expect(service.cancelOrder(user, 1)).rejects.toBeInstanceOf(
                GeneralTransactionException,
            );
        });

        it("cancels SWAP order and refunds via executeInternalBuy", async () => {
            const { service, prisma, buyOrderService, walletAddressService } = makeDeps();
            prisma.order.findFirst.mockResolvedValue(
                pendingOrder({ orderCategory: OrderCategory.SWAP, currency: "USDT", amount: 50 }),
            );
            buyOrderService.executeInternalBuy.mockResolvedValue({ ok: true });
            prisma.order.update.mockResolvedValue(
                pendingOrder({ orderCategory: OrderCategory.SWAP, status: OrderStatus.cancelled, streamlinedStatus: "cancelled" }),
            );

            const res = await service.cancelOrder(user, 1);

            expect(buyOrderService.executeInternalBuy).toHaveBeenCalledWith(
                user,
                50,
                "USDT",
                expect.stringContaining("_refund"),
            );
            expect(walletAddressService.syncWallet).toHaveBeenCalled();
            expect(res.data.status).toBe(OrderStatus.cancelled);
        });

        it("throws when SWAP refund fails", async () => {
            const { service, prisma, buyOrderService } = makeDeps();
            prisma.order.findFirst.mockResolvedValue(
                pendingOrder({ orderCategory: OrderCategory.SWAP }),
            );
            buyOrderService.executeInternalBuy.mockRejectedValue(new Error("refund failed"));

            await expect(service.cancelOrder(user, 1)).rejects.toBeInstanceOf(
                GeneralTransactionException,
            );
        });
    });

    describe("fees and conversion", () => {
        it("getFee handles flat fee", async () => {
            const { service } = makeDeps();
            const fee = await service.getFee(100, { type: "flat", fee: 4 });
            expect(fee).toEqual({ fee: 4, type: "flat" });
        });

        it("getFee handles percentage fee", async () => {
            const { service } = makeDeps();
            const fee = await service.getFee(200, { type: "percentage", fee: 2.5 });
            expect(fee).toEqual({ fee: 5, type: "percentage" });
        });

        it("getFee handles range fee (percentage)", async () => {
            const { service } = makeDeps();
            const fee = await service.getFee(500, {
                type: "range",
                fee: [
                    { min: 0, max: 100, type: "flat", value: 3 },
                    { min: 100, max: 1000, type: "percentage", value: 1.5 },
                ],
            });
            expect(fee).toEqual({ fee: 7.5, type: "percentage" });
        });

        it("getFee throws OutOfRangeException when range does not match", async () => {
            const { service } = makeDeps();
            await expect(
                service.getFee(1000, {
                    type: "range",
                    fee: [{ min: 0, max: 100, type: "flat", value: 3 }],
                }),
            ).rejects.toBeInstanceOf(OutOfRangeException);
        });

        it("getFee throws UnknownFeeStructureException for unsupported type", async () => {
            const { service } = makeDeps();
            await expect(
                service.getFee(100, { type: "mystery", fee: 3 }),
            ).rejects.toBeInstanceOf(UnknownFeeStructureException);
        });

        it("getAmountInNaira returns null when ticker missing", async () => {
            const { service, quidaxService } = makeDeps();
            quidaxService.getSingleMarketTicker.mockResolvedValue({ data: {} });

            const res = await service.getAmountInNaira("btc", 1, "buy");
            expect(res).toBeNull();
        });

        it("getAmountInNaira returns null when rate is NaN", async () => {
            const { service, quidaxService } = makeDeps();
            quidaxService.getSingleMarketTicker.mockResolvedValue({
                data: { ticker: { buy: "invalid" } },
            });

            const res = await service.getAmountInNaira("btc", 1, "buy");
            expect(res).toBeNull();
        });

        it("getAmountInNaira returns computed amount/rate", async () => {
            const { service, quidaxService } = makeDeps();
            quidaxService.getSingleMarketTicker.mockResolvedValue({
                data: { ticker: { buy: "1500", sell: "1400", last: "1450" } },
            });

            const res = await service.getAmountInNaira("btc", 2, "buy");
            expect(res).toEqual({ amount: 3000, rate: 1500 });
        });
    });

    describe("market and sparkline fallbacks", () => {
        it("getMarketChart uses LiveCoinWatch when available", async () => {
            const { service, liveCoinWatchService } = makeDeps();
            liveCoinWatchService.getMarketData.mockResolvedValue({
                rate: 100,
                cap: 1000,
                volume: 50,
                delta: { day: 1.1, week: 1.2, month: 0.9 },
                circulatingSupply: 1_000_000,
                maxSupply: 2_000_000,
            });
            liveCoinWatchService.getHistoricalData.mockResolvedValue({
                prices: [[1, 90], [2, 100]],
                high24h: 110,
                low24h: 80,
            });

            const res = await service.getMarketChart("btc", 7);

            expect(res.data.asset).toBe("BTC");
            expect(res.data.market_data.current_price).toBe(100);
            expect(res.data.prices.length).toBe(2);
        });

        it("getMarketChart falls back to CoinCap for market and history", async () => {
            const { service, liveCoinWatchService, coinCapService } = makeDeps();
            liveCoinWatchService.getMarketData.mockRejectedValue(new Error("lcw down"));
            liveCoinWatchService.getHistoricalData.mockRejectedValue(new Error("lcw history down"));
            coinCapService.getBatchMarketData.mockResolvedValue({
                btc: { price: 120, change24h: 5 },
            });
            coinCapService.getHistoricalData.mockResolvedValue({
                prices: [[1, 100], [2, 120]],
                high24h: 125,
                low24h: 95,
            });

            const res = await service.getMarketChart("btc", 7);

            expect(res.data.market_data.current_price).toBe(120);
            expect(res.data.market_data.price_change_percentage_24h).toBeCloseTo(5, 6);
            expect(res.data.prices.length).toBe(2);
        });

        it("getMarketChart returns null/empty data when both providers fail", async () => {
            const { service, liveCoinWatchService, coinCapService } = makeDeps();
            liveCoinWatchService.getMarketData.mockRejectedValue(new Error("lcw down"));
            liveCoinWatchService.getHistoricalData.mockRejectedValue(new Error("lcw history down"));
            coinCapService.getBatchMarketData.mockRejectedValue(new Error("cc down"));
            coinCapService.getHistoricalData.mockRejectedValue(new Error("cc history down"));

            const res = await service.getMarketChart("btc", 7);

            expect(res.data.market_data.current_price).toBeNull();
            expect(res.data.prices).toEqual([]);
        });

        it("getBatchSparklines uses LiveCoinWatch first", async () => {
            const { service, liveCoinWatchService } = makeDeps();
            liveCoinWatchService.getBatchSparklines.mockResolvedValue({ btc: [1, 2, 3] });

            const res = await service.getBatchSparklines(["btc"]);

            expect(res.data.btc).toEqual([1, 2, 3]);
        });

        it("getBatchSparklines falls back to CoinCap", async () => {
            const { service, liveCoinWatchService, coinCapService } = makeDeps();
            liveCoinWatchService.getBatchSparklines.mockRejectedValue(new Error("lcw down"));
            coinCapService.getBatchSparklines.mockResolvedValue({ btc: [3, 4] });

            const res = await service.getBatchSparklines(["btc"]);

            expect(res.data.btc).toEqual([3, 4]);
        });

        it("getBatchSparklines returns empty arrays when both providers fail", async () => {
            const { service, liveCoinWatchService, coinCapService } = makeDeps();
            liveCoinWatchService.getBatchSparklines.mockRejectedValue(new Error("lcw down"));
            coinCapService.getBatchSparklines.mockRejectedValue(new Error("cc down"));

            const res = await service.getBatchSparklines(["btc", "eth"]);

            expect(res.data).toEqual({ btc: [], eth: [] });
        });
    });

    describe("wallet update paths", () => {
        it("walletUpdatedHandler returns when wallet is not found", async () => {
            const { service, prisma } = makeDeps();
            prisma.assetWallet.findUnique.mockResolvedValue(null);

            await expect(
                service.walletUpdatedHandler({ walletId: "missing" } as any),
            ).resolves.toBeUndefined();
            expect(prisma.assetWallet.update).not.toHaveBeenCalled();
        });

        it("walletUpdatedHandler updates metadata and address flags", async () => {
            const { service, prisma } = makeDeps();
            prisma.assetWallet.findUnique.mockResolvedValue({ id: 9 });

            await service.walletUpdatedHandler({
                walletId: "wallet-1",
                updatedAt: "2026-03-28T10:00:00Z",
                depositAddress: "0xabc",
                destinationTag: "dt",
                referenceCurrency: "ngn",
            } as any);

            expect(prisma.assetWallet.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { id: 9 },
                    data: expect.objectContaining({
                        depositAddress: "0xabc",
                        addressSynced: true,
                        isActive: true,
                    }),
                }),
            );
        });

        it("walletAddressCreatedSuccessHandler exits safely when wallet address record is missing", async () => {
            const { service, prisma } = makeDeps();
            prisma.cryptoWalletAddress.findUnique.mockResolvedValue(null);

            await expect(
                service.walletAddressCreatedSuccessHandler({ walletAddressId: "wa-1" } as any),
            ).resolves.toBeUndefined();
            expect(prisma.cryptoWalletAddress.update).not.toHaveBeenCalled();
        });
    });

    describe("deposit sync and status refresh", () => {
        it("syncUserDeposits throws when user is missing sub-account", async () => {
            const { service, prisma } = makeDeps();
            prisma.user.findUnique.mockResolvedValue({
                id: 10,
                email: "user@example.com",
                cryptoSubAccountId: null,
            });

            await expect(service.syncUserDeposits(10)).rejects.toBeInstanceOf(Error);
        });

        it("syncUserDeposits creates only missing deposits", async () => {
            const { service, prisma, quidaxService } = makeDeps();
            prisma.user.findUnique.mockResolvedValue({
                id: 10,
                email: "user@example.com",
                firstName: "Test",
                lastName: "User",
                cryptoSubAccountId: "sub-10",
            });
            prisma.cryptoWalletAddress.findMany.mockResolvedValue([
                { assetSymbol: "USDT" },
            ]);
            quidaxService.fetchDeposits.mockImplementation(
                async ({ currency }: { currency: string }) => {
                    if (currency === "usdt") {
                        return {
                            data: [
                                {
                                    id: "dep-new-1",
                                    amount: "25",
                                    fee: "0",
                                    status: "successful",
                                    txid: "tx-1",
                                    created_at: "2026-03-28T12:00:00Z",
                                },
                                {
                                    id: "dep-existing-1",
                                    amount: "10",
                                    fee: "0",
                                    status: "successful",
                                    txid: "tx-2",
                                    created_at: "2026-03-28T12:01:00Z",
                                },
                            ],
                        };
                    }
                    return { data: [] };
                },
            );
            prisma.order.findUnique.mockImplementation(async ({ where }: any) => {
                if (where.providerOrderId === "dep-existing-1") {
                    return { id: 99, providerOrderId: "dep-existing-1" };
                }
                return null;
            });
            prisma.order.findMany.mockResolvedValue([]);
            quidaxService.getSingleMarketTicker.mockResolvedValue({
                data: { ticker: { buy: "1000" } },
            });

            const res = await service.syncUserDeposits(10);

            expect(res.data.synced).toBe(1);
            expect(res.data.skipped).toBeGreaterThanOrEqual(1);
            expect(prisma.order.create).toHaveBeenCalledTimes(1);
        });

        it("getOrderStatus returns selected order payload", async () => {
            const { service, prisma } = makeDeps();
            prisma.order.findFirst.mockResolvedValue({
                transactionId: "txn-1",
                status: OrderStatus.processing,
                streamlinedStatus: "pending",
                orderCategory: OrderCategory.SEND,
                updatedAt: new Date("2026-03-29T10:00:00Z"),
            });

            const res = await service.getOrderStatus({ id: 10 } as any, "txn-1");

            expect(res.data.transactionId).toBe("txn-1");
            expect(res.data.status).toBe(OrderStatus.processing);
        });

        it("refreshTransactionStatus returns early for final transaction states", async () => {
            const { service, prisma } = makeDeps();
            prisma.order.findFirst.mockResolvedValue(
                pendingOrder({ status: OrderStatus.done, streamlinedStatus: "completed" }),
            );

            const res = await service.refreshTransactionStatus(
                { id: 10, cryptoSubAccountId: "sub-1" } as any,
                "TX-1",
            );

            expect(res.message).toContain("already final");
            expect(res.data.status).toBe(OrderStatus.done);
        });

        it("refreshTransactionStatus refreshes SEND transactions from provider", async () => {
            const { service, prisma, quidaxService, webhookHandlerService } = makeDeps();
            prisma.order.findFirst.mockResolvedValue(
                pendingOrder({
                    orderCategory: OrderCategory.SEND,
                    status: OrderStatus.processing,
                    orderReference: "ref-send-1",
                }),
            );
            quidaxService.getWithdrawerByReference.mockResolvedValue({
                data: { status: OrderStatus.done, txid: "tx-hash-1" },
            });
            webhookHandlerService.withdrawerTransactionHandler.mockResolvedValue({ ok: true });

            const res = await service.refreshTransactionStatus(
                { id: 10, cryptoSubAccountId: "sub-1" } as any,
                "TX-1",
            );

            expect(webhookHandlerService.withdrawerTransactionHandler).toHaveBeenCalledWith(
                expect.objectContaining({
                    orderReference: "ref-send-1",
                    status: OrderStatus.done,
                }),
            );
            expect(res.message).toContain("completed successfully");
        });

        it("refreshTransactionStatus refreshes SWAP transactions from provider", async () => {
            const { service, prisma, quidaxService, webhookHandlerService } = makeDeps();
            prisma.order.findFirst.mockResolvedValue(
                pendingOrder({
                    orderCategory: OrderCategory.SWAP,
                    status: OrderStatus.processing,
                    providerOrderId: "swap-provider-1",
                }),
            );
            quidaxService.getSwapTransaction.mockResolvedValue({
                data: { status: OrderStatus.failed },
            });
            webhookHandlerService.swapTransactionHandler.mockResolvedValue({ ok: true });

            const res = await service.refreshTransactionStatus(
                { id: 10, cryptoSubAccountId: "sub-1" } as any,
                "TX-1",
            );

            expect(webhookHandlerService.swapTransactionHandler).toHaveBeenCalledWith(
                expect.objectContaining({
                    orderId: "swap-provider-1",
                    status: OrderStatus.failed,
                }),
            );
            expect(res.message).toContain("Swap failed");
        });

        it("refreshTransactionStatus throws when transaction does not exist", async () => {
            const { service, prisma } = makeDeps();
            prisma.order.findFirst.mockResolvedValue(null);

            await expect(
                service.refreshTransactionStatus({ id: 10, cryptoSubAccountId: "sub-1" } as any, "TX-404"),
            ).rejects.toBeInstanceOf(TransactionNotFoundException);
        });

        it("refreshTransactionStatus handles additional final statuses", async () => {
            const { service, prisma } = makeDeps();
            const user = { id: 10, cryptoSubAccountId: "sub-1" } as any;

            prisma.order.findFirst
                .mockResolvedValueOnce(pendingOrder({ status: OrderStatus.completed, streamlinedStatus: "completed" }))
                .mockResolvedValueOnce(pendingOrder({ status: OrderStatus.failed, streamlinedStatus: "failed" }))
                .mockResolvedValueOnce(pendingOrder({ status: OrderStatus.cancelled, streamlinedStatus: "cancelled" }));

            await expect(service.refreshTransactionStatus(user, "TX-final-1")).resolves.toMatchObject({
                message: "Transaction status is already final",
                data: { status: OrderStatus.completed },
            });
            await expect(service.refreshTransactionStatus(user, "TX-final-2")).resolves.toMatchObject({
                message: "Transaction status is already final",
                data: { status: OrderStatus.failed },
            });
            await expect(service.refreshTransactionStatus(user, "TX-final-3")).resolves.toMatchObject({
                message: "Transaction status is already final",
                data: { status: OrderStatus.cancelled },
            });
        });

        it("refreshTransactionStatus rejects non-final transactions when sub-account is missing", async () => {
            const { service, prisma } = makeDeps();
            prisma.order.findFirst.mockResolvedValue(
                pendingOrder({ status: OrderStatus.processing, streamlinedStatus: "processing" }),
            );

            await expect(
                service.refreshTransactionStatus({ id: 10, cryptoSubAccountId: null } as any, "TX-no-sub"),
            ).rejects.toThrow("Account setup incomplete");
        });

        it("refreshTransactionStatus returns unsupported response for non-SEND/SELL/SWAP categories", async () => {
            const { service, prisma } = makeDeps();
            prisma.order.findFirst.mockResolvedValue(
                pendingOrder({ orderCategory: OrderCategory.BUY, status: OrderStatus.processing }),
            );

            const res = await service.refreshTransactionStatus(
                { id: 10, cryptoSubAccountId: "sub-1" } as any,
                "TX-buy",
            );

            expect(res.message).toContain("does not support manual refresh");
            expect(res.data.status).toBe(OrderStatus.processing);
        });

        it("refreshTransactionStatus handles SEND rejected, still-processing, and provider failure paths", async () => {
            const { service, prisma, quidaxService, webhookHandlerService } = makeDeps();

            prisma.order.findFirst
                .mockResolvedValueOnce(
                    pendingOrder({ orderCategory: OrderCategory.SEND, orderReference: "ref-rejected" }),
                )
                .mockResolvedValueOnce(
                    pendingOrder({ orderCategory: OrderCategory.SEND, orderReference: "ref-pending" }),
                )
                .mockResolvedValueOnce(
                    pendingOrder({ orderCategory: OrderCategory.SEND, orderReference: "ref-error" }),
                );

            quidaxService.getWithdrawerByReference
                .mockResolvedValueOnce({ data: { status: OrderStatus.rejected, txid: "tx-rej" } })
                .mockResolvedValueOnce({ data: { status: "processing", txid: "tx-proc" } })
                .mockRejectedValueOnce(new Error("provider down"));

            webhookHandlerService.withdrawerTransactionHandler.mockResolvedValue({ ok: true });

            await expect(
                service.refreshTransactionStatus({ id: 10, cryptoSubAccountId: "sub-1" } as any, "TX-send-1"),
            ).resolves.toMatchObject({ message: "Transaction was rejected" });

            await expect(
                service.refreshTransactionStatus({ id: 10, cryptoSubAccountId: "sub-1" } as any, "TX-send-2"),
            ).resolves.toMatchObject({ message: "Transaction is still processing" });

            await expect(
                service.refreshTransactionStatus({ id: 10, cryptoSubAccountId: "sub-1" } as any, "TX-send-3"),
            ).resolves.toMatchObject({ message: "Unable to refresh status. Please try again later." });
        });

        it("refreshTransactionStatus rejects SEND transactions without order reference", async () => {
            const { service, prisma } = makeDeps();
            prisma.order.findFirst.mockResolvedValue(
                pendingOrder({ orderCategory: OrderCategory.SEND, orderReference: null }),
            );

            await expect(
                service.refreshTransactionStatus({ id: 10, cryptoSubAccountId: "sub-1" } as any, "TX-send-missing-ref"),
            ).rejects.toBeInstanceOf(GeneralTransactionException);
        });

        it("refreshTransactionStatus handles SWAP completed, still-processing, and provider failure paths", async () => {
            const { service, prisma, quidaxService, webhookHandlerService } = makeDeps();

            prisma.order.findFirst
                .mockResolvedValueOnce(
                    pendingOrder({ orderCategory: OrderCategory.SWAP, providerOrderId: "swap-done" }),
                )
                .mockResolvedValueOnce(
                    pendingOrder({ orderCategory: OrderCategory.SWAP, providerOrderId: "swap-processing" }),
                )
                .mockResolvedValueOnce(
                    pendingOrder({ orderCategory: OrderCategory.SWAP, providerOrderId: "swap-error" }),
                );

            quidaxService.getSwapTransaction
                .mockResolvedValueOnce({ data: { status: OrderStatus.completed } })
                .mockResolvedValueOnce({ data: { status: OrderStatus.processing } })
                .mockRejectedValueOnce(new Error("swap provider down"));

            webhookHandlerService.swapTransactionHandler.mockResolvedValue({ ok: true });

            await expect(
                service.refreshTransactionStatus({ id: 10, cryptoSubAccountId: "sub-1" } as any, "TX-swap-1"),
            ).resolves.toMatchObject({ message: "Swap completed successfully" });

            await expect(
                service.refreshTransactionStatus({ id: 10, cryptoSubAccountId: "sub-1" } as any, "TX-swap-2"),
            ).resolves.toMatchObject({ message: "Swap is still processing" });

            await expect(
                service.refreshTransactionStatus({ id: 10, cryptoSubAccountId: "sub-1" } as any, "TX-swap-3"),
            ).resolves.toMatchObject({ message: "Unable to refresh status. Please try again later." });
        });

        it("refreshTransactionStatus rejects SWAP transactions without provider order id", async () => {
            const { service, prisma } = makeDeps();
            prisma.order.findFirst.mockResolvedValue(
                pendingOrder({ orderCategory: OrderCategory.SWAP, providerOrderId: null }),
            );

            await expect(
                service.refreshTransactionStatus({ id: 10, cryptoSubAccountId: "sub-1" } as any, "TX-swap-missing-provider-id"),
            ).rejects.toBeInstanceOf(GeneralTransactionException);
        });

        it("normalizes deposit statuses and detects BUY-related deposits by amount tolerance", async () => {
            const { service, prisma } = makeDeps();

            expect((service as any).normalizeDepositStatus("successful")).toBe(OrderStatus.accepted);
            expect((service as any).normalizeDepositStatus("pending")).toBe(OrderStatus.pending);
            expect((service as any).normalizeDepositStatus("failed")).toBe(OrderStatus.rejected);
            expect((service as any).normalizeDepositStatus("unknown-status")).toBe(OrderStatus.pending);

            prisma.order.findMany
                .mockResolvedValueOnce([{ amount: 100 }])
                .mockResolvedValueOnce([{ amount: 100 }])
                .mockResolvedValueOnce([{ amount: 0 }]);

            await expect((service as any).isBuyOrderRelatedDeposit(10, "btc", 90)).resolves.toBe(true);
            await expect((service as any).isBuyOrderRelatedDeposit(10, "btc", 160)).resolves.toBe(false);
            await expect((service as any).isBuyOrderRelatedDeposit(10, "btc", 1)).resolves.toBe(false);
        });

        it("debugUserWallet returns combined db/provider information", async () => {
            const { service, prisma, quidaxService } = makeDeps();
            prisma.user.findUnique.mockResolvedValue({
                id: 10,
                email: "user@example.com",
                cryptoSubAccountId: "sub-10",
            });
            prisma.cryptoWalletAddress.findFirst.mockResolvedValue({
                id: 1,
                assetSymbol: "USDT",
            });
            quidaxService.getUserWalletList.mockResolvedValue({
                data: [{ currency: "usdt", balance: "100" }],
            });
            quidaxService.createPaymentAddress.mockResolvedValue({
                data: { address: "Tabc123" },
            });
            quidaxService.fetchDeposits.mockResolvedValue({
                data: [{ id: "dep-1", amount: "5" }],
            });

            const res = await service.debugUserWallet(10, "usdt");

            expect(res.user.email).toBe("user@example.com");
            expect(res.quidax.wallet.currency).toBe("usdt");
            expect(Array.isArray(res.quidax.deposits)).toBe(true);
            expect(res.quidax.deposits.length).toBe(1);
        });
    });
});
