import { MockTradingProvider, ITradingProvider } from "../trading-provider.interface";

describe("MockTradingProvider", () => {
    let mockProvider: MockTradingProvider;

    beforeEach(() => {
        mockProvider = new MockTradingProvider();
    });

    describe("Provider Identification", () => {
        it("should have providerName as 'mock'", () => {
            expect(mockProvider.providerName).toBe("mock");
        });
    });

    describe("setResponse and method calls", () => {
        it("should return set response for createSubAccount", async () => {
            const mockResponse = {
                status: "success" as const,
                data: {
                    id: "test-id",
                    email: "test@example.com",
                    firstName: "John",
                    lastName: "Doe",
                    status: "active",
                    createdAt: new Date(),
                },
            };

            mockProvider.setResponse("createSubAccount", mockResponse);

            const result = await mockProvider.createSubAccount({
                email: "test@example.com",
                firstName: "John",
                lastName: "Doe",
            });

            expect(result).toEqual(mockResponse);
        });

        it("should return set response for getUserWallet", async () => {
            const mockResponse = {
                status: "success" as const,
                data: {
                    currency: "btc",
                    balance: "1.5",
                    lockedBalance: "0.1",
                    availableBalance: "1.4",
                },
            };

            mockProvider.setResponse("getUserWallet", mockResponse);

            const result = await mockProvider.getUserWallet("user-123", "btc");

            expect(result).toEqual(mockResponse);
        });

        it("should return set response for placeOrder", async () => {
            const mockResponse = {
                status: "success" as const,
                data: {
                    id: "order-123",
                    pair: "btcngn",
                    side: "buy" as const,
                    type: "market" as const,
                    status: "done",
                    price: "50000000",
                    volume: "0.001",
                    executedVolume: "0.001",
                    remainingVolume: "0",
                    createdAt: new Date(),
                    updatedAt: new Date(),
                },
            };

            mockProvider.setResponse("placeOrder", mockResponse);

            const result = await mockProvider.placeOrder({
                userId: "user-123",
                pair: "btcngn",
                side: "buy",
                type: "market",
                amount: "0.001",
            });

            expect(result).toEqual(mockResponse);
        });

        it("should throw error when response is not set", async () => {
            await expect(
                mockProvider.createSubAccount({
                    email: "test@example.com",
                    firstName: "John",
                    lastName: "Doe",
                })
            ).rejects.toThrow("MockTradingProvider: No mock response set for method 'createSubAccount'");
        });
    });

    describe("Swap Operations", () => {
        it("should return set response for createSwapQuote", async () => {
            const mockResponse = {
                status: "success" as const,
                data: {
                    id: "quote-123",
                    fromCurrency: "btc",
                    toCurrency: "eth",
                    fromAmount: "0.1",
                    toAmount: "1.5",
                    rate: "15",
                    fee: "0.001",
                    expiresAt: new Date(Date.now() + 60000),
                },
            };

            mockProvider.setResponse("createSwapQuote", mockResponse);

            const result = await mockProvider.createSwapQuote({
                userId: "user-123",
                fromCurrency: "btc",
                toCurrency: "eth",
                fromAmount: "0.1",
            });

            expect(result).toEqual(mockResponse);
        });

        it("should return set response for confirmSwap", async () => {
            const mockResponse = {
                status: "success" as const,
                data: {
                    id: "swap-123",
                    fromCurrency: "btc",
                    toCurrency: "eth",
                    fromAmount: "0.1",
                    toAmount: "1.5",
                    status: "completed",
                    createdAt: new Date(),
                },
            };

            mockProvider.setResponse("confirmSwap", mockResponse);

            const result = await mockProvider.confirmSwap({
                userId: "user-123",
                quoteId: "quote-123",
            });

            expect(result).toEqual(mockResponse);
        });
    });

    describe("Withdrawal Operations", () => {
        it("should return set response for createWithdrawal", async () => {
            const mockResponse = {
                status: "success" as const,
                data: {
                    id: "withdrawal-123",
                    currency: "btc",
                    amount: "0.1",
                    fee: "0.0001",
                    status: "pending",
                    address: "bc1q...",
                    createdAt: new Date(),
                },
            };

            mockProvider.setResponse("createWithdrawal", mockResponse);

            const result = await mockProvider.createWithdrawal({
                userId: "user-123",
                currency: "btc",
                amount: "0.1",
                address: "bc1q...",
            });

            expect(result).toEqual(mockResponse);
        });

        it("should return set response for getWithdrawalFees", async () => {
            const mockResponse = {
                status: "success" as const,
                data: {
                    currency: "btc",
                    fee: "0.0001",
                    minimumAmount: "0.001",
                },
            };

            mockProvider.setResponse("getWithdrawalFees", mockResponse);

            const result = await mockProvider.getWithdrawalFees("user-123", "btc");

            expect(result).toEqual(mockResponse);
        });
    });

    describe("Market Data Operations", () => {
        it("should return set response for getMarketTickers", async () => {
            const mockResponse = {
                status: "success" as const,
                data: [
                    {
                        pair: "btcngn",
                        lastPrice: "50000000",
                        bidPrice: "49999000",
                        askPrice: "50001000",
                        volume24h: "100",
                        change24h: "5.5",
                        high24h: "51000000",
                        low24h: "48000000",
                    },
                ],
            };

            mockProvider.setResponse("getMarketTickers", mockResponse);

            const result = await mockProvider.getMarketTickers();

            expect(result).toEqual(mockResponse);
        });
    });

    describe("Interface Compliance", () => {
        it("should implement all ITradingProvider methods", () => {
            // Account methods
            expect(typeof mockProvider.createSubAccount).toBe("function");
            expect(typeof mockProvider.findSubAccountByEmail).toBe("function");
            expect(typeof mockProvider.getAccountDetail).toBe("function");

            // Wallet methods
            expect(typeof mockProvider.getUserWalletList).toBe("function");
            expect(typeof mockProvider.getUserWallet).toBe("function");
            expect(typeof mockProvider.createPaymentAddress).toBe("function");
            expect(typeof mockProvider.getPaymentAddressById).toBe("function");
            expect(typeof mockProvider.getPaymentAddressList).toBe("function");
            expect(typeof mockProvider.verifyAddress).toBe("function");

            // Order methods
            expect(typeof mockProvider.placeOrder).toBe("function");
            expect(typeof mockProvider.cancelOrder).toBe("function");
            expect(typeof mockProvider.getOrderById).toBe("function");
            expect(typeof mockProvider.getOrderList).toBe("function");

            // Swap methods
            expect(typeof mockProvider.createSwapQuote).toBe("function");
            expect(typeof mockProvider.confirmSwap).toBe("function");
            expect(typeof mockProvider.getSwapTransaction).toBe("function");
            expect(typeof mockProvider.getSwapTransactionList).toBe("function");

            // Withdrawal methods
            expect(typeof mockProvider.createWithdrawal).toBe("function");
            expect(typeof mockProvider.cancelWithdrawal).toBe("function");
            expect(typeof mockProvider.getWithdrawalById).toBe("function");
            expect(typeof mockProvider.getWithdrawalByReference).toBe("function");
            expect(typeof mockProvider.getWithdrawalList).toBe("function");
            expect(typeof mockProvider.getWithdrawalFees).toBe("function");

            // Deposit methods
            expect(typeof mockProvider.fetchDeposits).toBe("function");
            expect(typeof mockProvider.fetchDeposit).toBe("function");

            // Market data methods
            expect(typeof mockProvider.getMarketTickers).toBe("function");
            expect(typeof mockProvider.getSingleMarketTicker).toBe("function");
            expect(typeof mockProvider.getMarketList).toBe("function");

            // Purchase methods
            expect(typeof mockProvider.getPurchaseLimitForBuy).toBe("function");
            expect(typeof mockProvider.getPurchaseLimitForSell).toBe("function");
            expect(typeof mockProvider.getPurchaseQuoteForBuy).toBe("function");
            expect(typeof mockProvider.getPurchaseQuoteForSell).toBe("function");
        });
    });
});

describe("ITradingProvider Interface Types", () => {
    it("should accept MockTradingProvider as ITradingProvider", () => {
        const provider: ITradingProvider = new MockTradingProvider();
        expect(provider.providerName).toBe("mock");
    });

    it("should define correct ProviderResponse structure", () => {
        const mockProvider = new MockTradingProvider();
        mockProvider.setResponse("getUserWallet", {
            status: "success" as const,
            message: "Wallet retrieved successfully",
            data: {
                currency: "btc",
                balance: "1.0",
                lockedBalance: "0",
                availableBalance: "1.0",
            },
        });

        // This test verifies TypeScript type compatibility
        expect(true).toBe(true);
    });
});
