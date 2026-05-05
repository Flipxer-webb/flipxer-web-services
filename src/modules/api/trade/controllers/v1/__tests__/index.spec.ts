jest.mock("@nestjs/common", () => {
    const actual = jest.requireActual("@nestjs/common");
    return {
        ...actual,
        UseGuards: () => () => undefined,
        UsePipes: () => () => undefined,
    };
});

jest.mock("@/modules/api/auth/guard", () => ({
    AuthGuard: class AuthGuard {
        canActivate() {
            return true;
        }
    },
    CountryBlockGuard: class CountryBlockGuard {
        canActivate() {
            return true;
        }
    },
    TransactionAmountGuard: class TransactionAmountGuard {
        canActivate() {
            return true;
        }
    },
    __esModule: true,
}));

jest.mock("@/modules/api/auth", () => ({}));

jest.mock("@/modules/api/user", () => ({
    User: () => () => {},
    ClientData: () => () => {},
    UserModule: class {
        readonly __stub = true;
    },
    AccountDeletedException: class extends Error {},
    UserNotFoundException: class extends Error {},
    __esModule: true,
}));

import { TradingController } from "../index";

describe("TradingController", () => {
    let controller: TradingController;
    let tradingService: Record<string, jest.Mock>;
    const user = { id: 77 } as any;

    beforeEach(() => {
        tradingService = {
            getSupportedAssets: jest.fn().mockResolvedValue({ data: ["BTC"] }),
            getSupportedPaymentMethod: jest
                .fn()
                .mockResolvedValue({ data: ["bank"] }),
            getSupportedNetworks: jest
                .fn()
                .mockResolvedValue({ data: ["TRC20"] }),
            getSupportedTradingPairs: jest
                .fn()
                .mockResolvedValue({ data: ["BTC/USDT"] }),
            getPurchaseLimitForBuy: jest
                .fn()
                .mockResolvedValue({ data: { max: 1000 } }),
            verifyWalletAddress: jest
                .fn()
                .mockResolvedValue({ data: { valid: true } }),
            getCryptoWithdrawerFee: jest
                .fn()
                .mockResolvedValue({ data: { fee: 2 } }),
            getWalletAddress: jest
                .fn()
                .mockResolvedValue({ data: { address: "T123" } }),
            getWalletAddresses: jest.fn().mockResolvedValue({ data: [] }),
            initiateWalletAddressCreation: jest
                .fn()
                .mockResolvedValue({ message: "queued" }),
            triggerQuidaxAccountCreation: jest
                .fn()
                .mockResolvedValue({ message: "ok" }),
            buyCryptoQuoteRequest: jest
                .fn()
                .mockResolvedValue({ data: { quote: "q1" } }),
            buyCryptoOrder: jest
                .fn()
                .mockResolvedValue({ data: { orderId: 10 } }),
            getBuyOrderStatus: jest
                .fn()
                .mockResolvedValue({ data: { status: "pending" } }),
            cancelBuyOrder: jest
                .fn()
                .mockResolvedValue({ message: "cancelled" }),
            notifyPendingBuyOrder: jest
                .fn()
                .mockResolvedValue({ message: "sent" }),
            confirmPaymentSent: jest
                .fn()
                .mockResolvedValue({ message: "confirmed" }),
            sellCryptoQuoteRequest: jest
                .fn()
                .mockResolvedValue({ data: { quote: "s1" } }),
            sellCryptoOrder: jest
                .fn()
                .mockResolvedValue({ data: { orderId: 11 } }),
            getSwapEstimate: jest
                .fn()
                .mockResolvedValue({ data: { estimate: "e1" } }),
            createInstantSwap: jest
                .fn()
                .mockResolvedValue({ data: { quoteId: "swap-1" } }),
            confirmInstantSwapQuote: jest
                .fn()
                .mockResolvedValue({ data: { status: "ok" } }),
            refreshInstantSwap: jest
                .fn()
                .mockResolvedValue({ data: { quoteId: "swap-2" } }),
            withdrawerRequest: jest
                .fn()
                .mockResolvedValue({ data: { tx: "wd-1" } }),
            getMarketChart: jest.fn().mockResolvedValue({ data: [] }),
            getBatchSparklines: jest.fn().mockResolvedValue({ data: [] }),
            getOrderStatus: jest
                .fn()
                .mockResolvedValue({ data: { status: "processing" } }),

            enqueueUserDepositSync: jest
                .fn()
                .mockResolvedValue({ message: "queued" }),
        };

        controller = new TradingController(tradingService as any);
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    it("delegates public info endpoints", async () => {
        const paymentQuery = { country: "NG" } as any;
        const limitQuery = { amount: 100 } as any;
        const verifyDto = { address: "T123" } as any;
        const feeDto = { currency: "btc" } as any;

        await controller.getSupportedAssets();
        await controller.getSupportedPaymentMethod(paymentQuery);
        await controller.getSupportedNetworks();
        await controller.getSupportedTradingPairs();
        await controller.getPurchaseLimitForBuy(limitQuery);
        await controller.verifyWalletAddress(verifyDto);
        await controller.getWithdrawerFee(feeDto);

        expect(tradingService.getSupportedAssets).toHaveBeenCalledTimes(1);
        expect(tradingService.getSupportedPaymentMethod).toHaveBeenCalledWith(
            paymentQuery,
        );
        expect(tradingService.getSupportedNetworks).toHaveBeenCalledTimes(1);
        expect(tradingService.getSupportedTradingPairs).toHaveBeenCalledTimes(
            1,
        );
        expect(tradingService.getPurchaseLimitForBuy).toHaveBeenCalledWith(
            limitQuery,
        );
        expect(tradingService.verifyWalletAddress).toHaveBeenCalledWith(
            verifyDto,
        );
        expect(tradingService.getCryptoWithdrawerFee).toHaveBeenCalledWith(
            feeDto,
        );
    });

    it("delegates wallet and buy/sell flows with authenticated user", async () => {
        const walletDto = { asset: "usdt" } as any;
        const walletListDto = { currency: "usdt" } as any;
        const initiateWalletDto = { currency: "usdt", network: "trc20" } as any;
        const buyQuoteDto = { market: "btcngn", amount: "5000" } as any;
        const buyOrderDto = { quoteId: "buy-quote" } as any;
        const sellQuoteDto = { market: "btcngn", amount: "0.01" } as any;
        const sellOrderDto = { quoteId: "sell-quote" } as any;

        await controller.getWalletAddress(walletDto, user);
        await controller.getWalletAddresses(walletListDto, user);
        await controller.initiateWalletCreation(initiateWalletDto, user);
        await controller.triggerQuidaxAccountCreation(user);

        await controller.buyCrypto(buyQuoteDto, user);
        await controller.buyCryptoOrder(buyOrderDto, user);
        await controller.getBuyOrderStatus("buy-ref", user);
        await controller.cancelBuyOrder("buy-ref", user);
        await controller.notifyPendingBuyOrder("buy-ref", user);
        await controller.confirmPaymentSent("buy-ref", user);

        await controller.sellCryptoRequest(sellQuoteDto, user);
        await controller.sellCryptoOrder(sellOrderDto, user);

        expect(tradingService.getWalletAddress).toHaveBeenCalledWith(
            77,
            walletDto,
        );
        expect(tradingService.getWalletAddresses).toHaveBeenCalledWith(
            77,
            walletListDto,
        );
        expect(
            tradingService.initiateWalletAddressCreation,
        ).toHaveBeenCalledWith(77, initiateWalletDto);
        expect(
            tradingService.triggerQuidaxAccountCreation,
        ).toHaveBeenCalledWith(user);
        expect(tradingService.buyCryptoQuoteRequest).toHaveBeenCalledWith(
            user,
            buyQuoteDto,
        );
        expect(tradingService.buyCryptoOrder).toHaveBeenCalledWith(
            user,
            buyOrderDto,
        );
        expect(tradingService.getBuyOrderStatus).toHaveBeenCalledWith(
            "buy-ref",
            77,
        );
        expect(tradingService.cancelBuyOrder).toHaveBeenCalledWith(
            "buy-ref",
            77,
        );
        expect(tradingService.notifyPendingBuyOrder).toHaveBeenCalledWith(
            "buy-ref",
            77,
        );
        expect(tradingService.confirmPaymentSent).toHaveBeenCalledWith(
            "buy-ref",
            77,
        );
        expect(tradingService.sellCryptoQuoteRequest).toHaveBeenCalledWith(
            user,
            sellQuoteDto,
        );
        expect(tradingService.sellCryptoOrder).toHaveBeenCalledWith(
            user,
            sellOrderDto,
        );
    });

    it("delegates swap, withdrawal and order status flows", async () => {
        const swapDto = {
            fromCurrency: "usdt",
            toCurrency: "btc",
            amount: "100",
        } as any;
        const confirmSwapDto = {
            quoteId: "swap-quote",
            idempotencyKey: "idem-1",
        } as any;
        const refreshSwapDto = { quoteId: "swap-quote" } as any;
        const withdrawDto = {
            currency: "usdt",
            amount: "50",
            beneficiaryId: "ben-1",
        } as any;
        const chartQuery = { asset: "btc", days: 7 } as any;
        const sparklineQuery = { assets: "btc, eth, usdt" } as any;

        await controller.getSwapEstimate(swapDto, user);
        await controller.createInstantSwap(swapDto, user);
        await controller.confirmInstantSwapQuote(confirmSwapDto, user);
        await controller.refreshInstantSwapQuote(refreshSwapDto, user);
        await controller.withdrawerRequest(withdrawDto, user);
        await controller.getMarketChart(chartQuery);
        await controller.getBatchSparklines(sparklineQuery);
        await controller.getOrderStatus("tx-1", user);

        await controller.syncDeposits(user);

        expect(tradingService.getSwapEstimate).toHaveBeenCalledWith(
            user,
            swapDto,
        );
        expect(tradingService.createInstantSwap).toHaveBeenCalledWith(
            user,
            swapDto,
        );
        expect(tradingService.confirmInstantSwapQuote).toHaveBeenCalledWith(
            user,
            confirmSwapDto,
        );
        expect(tradingService.refreshInstantSwap).toHaveBeenCalledWith(
            user,
            refreshSwapDto,
        );
        expect(tradingService.withdrawerRequest).toHaveBeenCalledWith(
            user,
            withdrawDto,
        );
        expect(tradingService.getMarketChart).toHaveBeenCalledWith("btc", 7);
        expect(tradingService.getBatchSparklines).toHaveBeenCalledWith([
            "btc",
            "eth",
            "usdt",
        ]);
        expect(tradingService.getOrderStatus).toHaveBeenCalledWith(
            user,
            "tx-1",
        );

        expect(tradingService.enqueueUserDepositSync).toHaveBeenCalledWith(77);
    });
});
