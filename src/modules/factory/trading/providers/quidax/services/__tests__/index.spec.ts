import { HttpStatus, Logger } from "@nestjs/common";

import { QuidaxValidationError } from "@/libs/quidax";

import { QuidaxException } from "../../errors";
import { QuidaxAccountService, namespaceEmail } from "../account.service";
import { executeQuidaxCall, handleQuidaxError } from "../error-handler";
import { QuidaxService } from "../index";

type QuidaxMethodName =
    | "findSubAccountByEmail"
    | "createSubAccount"
    | "getAccountDetail"
    | "getUserWalletList"
    | "getUserWallet"
    | "getPaymentAddress"
    | "getPaymentAddressList"
    | "getPaymentAddressById"
    | "createPaymentAddress"
    | "verifyAddress"
    | "fetchDeposits"
    | "fetchDeposit"
    | "createWithdrawerRequest"
    | "cancelWithdrawerRequest"
    | "getWithdrawerList"
    | "getWithdrawerDetail"
    | "getWithdrawerByReference"
    | "getWithdrawerFees"
    | "buyOrSellOrderRequest"
    | "cancelBuyOrSellOrderRequest"
    | "getAllOrders"
    | "getOrderRecord"
    | "getOrderBookItemsForAMarket"
    | "instantOrdersRequery"
    | "createInstantSwapRequest"
    | "confirmInstantSwap"
    | "refreshInstantSwapQuote"
    | "getSwapTransaction"
    | "getSwapTransactionList"
    | "getMarketList"
    | "getMarketTickers"
    | "getSingleMarketTicker"
    | "getPaymentMethods"
    | "getPurchaseLimitForBuy"
    | "getPurchaseLimitForSell"
    | "getPurchaseQuoteForBuy"
    | "getPurchaseQuoteForSell";

function buildQuidaxMock() {
    const mock = {} as Record<QuidaxMethodName, jest.Mock>;
    const methodNames: QuidaxMethodName[] = [
        "findSubAccountByEmail",
        "createSubAccount",
        "getAccountDetail",
        "getUserWalletList",
        "getUserWallet",
        "getPaymentAddress",
        "getPaymentAddressList",
        "getPaymentAddressById",
        "createPaymentAddress",
        "verifyAddress",
        "fetchDeposits",
        "fetchDeposit",
        "createWithdrawerRequest",
        "cancelWithdrawerRequest",
        "getWithdrawerList",
        "getWithdrawerDetail",
        "getWithdrawerByReference",
        "getWithdrawerFees",
        "buyOrSellOrderRequest",
        "cancelBuyOrSellOrderRequest",
        "getAllOrders",
        "getOrderRecord",
        "getOrderBookItemsForAMarket",
        "instantOrdersRequery",
        "createInstantSwapRequest",
        "confirmInstantSwap",
        "refreshInstantSwapQuote",
        "getSwapTransaction",
        "getSwapTransactionList",
        "getMarketList",
        "getMarketTickers",
        "getSingleMarketTicker",
        "getPaymentMethods",
        "getPurchaseLimitForBuy",
        "getPurchaseLimitForSell",
        "getPurchaseQuoteForBuy",
        "getPurchaseQuoteForSell",
    ];

    for (const methodName of methodNames) {
        mock[methodName] = jest.fn();
    }

    return mock;
}

describe("Quidax error handler", () => {
    const logger = { error: jest.fn() } as unknown as Logger;

    afterEach(() => {
        jest.clearAllMocks();
    });

    it("executeQuidaxCall should return response for a successful callback", async () => {
        const result = await executeQuidaxCall(
            async () => ({ ok: true }),
            "fetch data",
            logger,
        );

        expect(result).toEqual({ ok: true });
    });

    it("executeQuidaxCall should throw QuidaxException for falsy responses", async () => {
        await expect(
            executeQuidaxCall(async () => null, "create wallet", logger),
        ).rejects.toBeInstanceOf(QuidaxException);
    });

    it("handleQuidaxError should preserve status and code for Quidax errors", () => {
        const validationError = new QuidaxValidationError("already exists", "E0101");

        try {
            handleQuidaxError(validationError, "fallback", logger);
            fail("Expected handleQuidaxError to throw");
        } catch (error) {
            const typedError = error as QuidaxException;
            expect(typedError).toBeInstanceOf(QuidaxException);
            expect(typedError.code).toBe("E0101");
            expect(typedError.getStatus()).toBe(HttpStatus.BAD_REQUEST);
        }
    });

    it("handleQuidaxError should map unknown errors to NOT_IMPLEMENTED", () => {
        try {
            handleQuidaxError(new Error("boom"), "Fallback message", logger);
            fail("Expected handleQuidaxError to throw");
        } catch (error) {
            const typedError = error as QuidaxException;
            expect(typedError.getStatus()).toBe(HttpStatus.NOT_IMPLEMENTED);
            expect(typedError.message).toContain("Fallback message");
        }
    });
});

describe("namespaceEmail", () => {
    let originalEnv: string | undefined;

    afterEach(() => {
        if (originalEnv === undefined) {
            delete process.env.ENVIRONMENT;
        } else {
            process.env.ENVIRONMENT = originalEnv;
        }
    });

    it("returns email unchanged in production", () => {
        originalEnv = process.env.ENVIRONMENT;
        process.env.ENVIRONMENT = "production";
        expect(namespaceEmail("user@example.com")).toBe("user@example.com");
    });

    it("prefixes with stg_ in staging", () => {
        originalEnv = process.env.ENVIRONMENT;
        process.env.ENVIRONMENT = "staging";
        expect(namespaceEmail("user@example.com")).toBe("stg_user@example.com");
    });

    it("prefixes with dev_ in development", () => {
        originalEnv = process.env.ENVIRONMENT;
        process.env.ENVIRONMENT = "development";
        expect(namespaceEmail("user@example.com")).toBe("dev_user@example.com");
    });

    it("defaults to dev_ when ENVIRONMENT is unset", () => {
        originalEnv = process.env.ENVIRONMENT;
        delete process.env.ENVIRONMENT;
        const originalNode = process.env.NODE_ENV;
        delete process.env.NODE_ENV;
        try {
            expect(namespaceEmail("user@example.com")).toBe("dev_user@example.com");
        } finally {
            process.env.NODE_ENV = originalNode;
        }
    });
});

describe("QuidaxAccountService", () => {
    let quidax: ReturnType<typeof buildQuidaxMock>;
    let service: QuidaxAccountService;
    let originalEnv: string | undefined;

    beforeEach(() => {
        originalEnv = process.env.ENVIRONMENT;
        process.env.ENVIRONMENT = "staging";

        quidax = buildQuidaxMock();
        service = new QuidaxAccountService(quidax as any);

        jest.spyOn((service as any).logger, "log").mockImplementation(() => undefined);
        jest.spyOn((service as any).logger, "warn").mockImplementation(() => undefined);
        jest.spyOn((service as any).logger, "error").mockImplementation(() => undefined);
    });

    afterEach(() => {
        if (originalEnv === undefined) {
            delete process.env.ENVIRONMENT;
        } else {
            process.env.ENVIRONMENT = originalEnv;
        }
        jest.restoreAllMocks();
        jest.clearAllMocks();
    });

    it("findSubAccountByEmail should namespace and delegate to Quidax library", async () => {
        quidax.findSubAccountByEmail.mockResolvedValue({ id: "sub-1", email: "stg_user@example.com" });

        const result = await service.findSubAccountByEmail("user@example.com");

        expect(result).toEqual({ id: "sub-1", email: "stg_user@example.com" });
        expect(quidax.findSubAccountByEmail).toHaveBeenCalledWith("stg_user@example.com");
    });

    it("findSubAccountByEmail should not namespace in production", async () => {
        process.env.ENVIRONMENT = "production";
        quidax.findSubAccountByEmail.mockResolvedValue({ id: "sub-1", email: "user@example.com" });

        const result = await service.findSubAccountByEmail("user@example.com");

        expect(quidax.findSubAccountByEmail).toHaveBeenCalledWith("user@example.com");
        expect(result).toEqual({ id: "sub-1", email: "user@example.com" });
    });

    it("createOrFindSubAccount should return existing account when found", async () => {
        const existing = { id: "sub-1", email: "stg_user@example.com" };
        quidax.findSubAccountByEmail.mockResolvedValue(existing);

        const result = await service.createOrFindSubAccount({
            email: "user@example.com",
            first_name: "Test",
            last_name: "User",
        } as any);

        expect(result.status).toBe("success");
        expect(result.data).toEqual(existing);
        expect(quidax.findSubAccountByEmail).toHaveBeenCalledWith("stg_user@example.com");
    });

    it("createOrFindSubAccount should retry lookup on E0101 and return found account", async () => {
        const setTimeoutSpy = jest
            .spyOn(globalThis, "setTimeout")
            .mockImplementation(((callback: TimerHandler) => {
                if (typeof callback === "function") {
                    callback();
                }
                return 0 as any;
            }) as any);

        quidax.findSubAccountByEmail
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ id: "sub-retry", email: "stg_retry@gmail.com" });

        quidax.createSubAccount.mockRejectedValueOnce(
            new QuidaxValidationError("already exists", "E0101"),
        );

        const result = await service.createOrFindSubAccount({
            email: "retry@gmail.com",
            first_name: "Retry",
            last_name: "User",
        } as any);

        expect(result.status).toBe("success");
        expect((result.data as any).id).toBe("sub-retry");
        expect(quidax.findSubAccountByEmail).toHaveBeenCalledTimes(2);
        expect(quidax.createSubAccount).toHaveBeenCalledTimes(1);
        // Verify the namespaced email was passed
        expect(quidax.createSubAccount).toHaveBeenCalledWith(
            expect.objectContaining({ email: "stg_retry@gmail.com" }),
        );

        setTimeoutSpy.mockRestore();
    });

    it("createOrFindSubAccount should retry with gmail alias when E0101 persists", async () => {
        const setTimeoutSpy = jest
            .spyOn(globalThis, "setTimeout")
            .mockImplementation(((callback: TimerHandler) => {
                if (typeof callback === "function") {
                    callback();
                }
                return 0 as any;
            }) as any);

        quidax.findSubAccountByEmail.mockResolvedValue(null);

        quidax.createSubAccount
            .mockRejectedValueOnce(
                new QuidaxValidationError("already exists", "E0101"),
            )
            .mockResolvedValueOnce({
                status: "success",
                message: "alias created",
                data: { id: "sub-alias" },
            });

        const result = await service.createOrFindSubAccount({
            email: "alias@gmail.com",
            first_name: "Alias",
            last_name: "User",
        } as any);

        expect(result.message).toBe("alias created");
        // Alias is applied to the namespaced email: stg_alias+flip123456@gmail.com
        const aliasCall = quidax.createSubAccount.mock.calls[1]?.[0] as any;
        expect(aliasCall.email).toMatch(/^stg_alias\+flip\d{6}@gmail\.com$/);

        setTimeoutSpy.mockRestore();
    });

    it("createOrFindSubAccount should retry with dot alias for non-gmail addresses", async () => {
        const setTimeoutSpy = jest
            .spyOn(globalThis, "setTimeout")
            .mockImplementation(((callback: TimerHandler) => {
                if (typeof callback === "function") {
                    callback();
                }
                return 0 as any;
            }) as any);

        quidax.findSubAccountByEmail.mockResolvedValue(null);

        quidax.createSubAccount
            .mockRejectedValueOnce(
                new QuidaxValidationError("already exists", "E0101"),
            )
            .mockResolvedValueOnce({
                status: "success",
                message: "alias created",
                data: { id: "sub-dot-alias" },
            });

        await service.createOrFindSubAccount({
            email: "alias@yahoo.com",
            first_name: "Alias",
            last_name: "User",
        } as any);

        // Alias is applied to the namespaced email: stg_alias.flip123456@yahoo.com
        const aliasCall = quidax.createSubAccount.mock.calls[1]?.[0] as any;
        expect(aliasCall.email).toMatch(/^stg_alias\.flip\d{6}@yahoo\.com$/);

        setTimeoutSpy.mockRestore();
    });

    it("createOrFindSubAccount should rethrow non-E0101 errors", async () => {
        quidax.findSubAccountByEmail.mockResolvedValue(null);
        quidax.createSubAccount.mockRejectedValueOnce(
            new QuidaxValidationError("bad request", "E0900"),
        );

        await expect(
            service.createOrFindSubAccount({
                email: "x@example.com",
                first_name: "X",
                last_name: "Y",
            } as any),
        ).rejects.toBeInstanceOf(QuidaxException);
    });
});

describe("QuidaxService facade", () => {
    let quidax: ReturnType<typeof buildQuidaxMock>;
    let service: QuidaxService;

    beforeEach(() => {
        quidax = buildQuidaxMock();
        for (const key of Object.keys(quidax)) {
            quidax[key as QuidaxMethodName].mockResolvedValue({
                status: "successful",
                message: "ok",
                data: { id: "1" },
            });
        }

        service = new QuidaxService(quidax as any);
        jest.spyOn((service as any).logger, "log").mockImplementation(() => undefined);
    });

    afterEach(() => {
        jest.restoreAllMocks();
        jest.clearAllMocks();
    });

    it("should delegate operations across all composed domain services", async () => {
        await service.findSubAccountByEmail("user@example.com");
        await service.createOrFindSubAccount({ email: "user@example.com", first_name: "F", last_name: "L" } as any);
        await service.createSubAccount({ email: "user@example.com", first_name: "F", last_name: "L" } as any);
        await service.getAccountDetail({ user_id: "uid" } as any);

        await service.getUserWalletList({ user_id: "uid" } as any);
        await service.getUserWallet({ user_id: "uid", currency: "btc" } as any);
        await service.getPaymentAddress({ user_id: "uid", currency: "btc" } as any);
        await service.getPaymentAddressList({ user_id: "uid", currency: "btc" } as any);
        await service.getPaymentAddressById({ user_id: "uid", currency: "btc", address_id: "a1" } as any);
        await service.createPaymentAddress({ user_id: "uid", currency: "btc", network: "btc" } as any);
        await service.verifyAddress({ currency: "btc", address: "addr" } as any);

        await service.fetchDeposits({ user_id: "uid" } as any);
        await service.fetchDeposit({ user_id: "uid", currency: "btc", deposit_id: "d1" } as any);

        await service.createWithdrawerRequest({ user_id: "uid", currency: "btc", amount: "1" } as any);
        await service.cancelWithdrawerRequest({ user_id: "uid", withdrawal_id: "w1" } as any);
        await service.getWithdrawerList("uid", { currency: "btc", state: "done" } as any);
        await service.getWithdrawerDetail({ user_id: "uid", withdrawal_id: "w1" } as any);
        await service.getWithdrawerByReference({ user_id: "uid", reference: "ref-1" } as any);
        await service.getWithdrawerFees({ currency: "btc" } as any);

        await service.buyOrSellOrderRequest("uid", { market: "btcngn", side: "buy" } as any);
        await service.cancelBuyOrSellOrderRequest("uid", { user_id: "uid", order_id: "o1" } as any);
        await service.getAllOrders("uid", { market: "btcngn", state: "done" } as any);
        await service.getOrderRecord({ user_id: "uid", order_id: "o1" } as any);
        await service.getOrderBookItemsForAMarket({ market: "btcngn" } as any);
        await service.instantOrdersRequery({ user_id: "uid", instant_order_id: "io1" } as any);

        await service.createInstantSwapRequest("uid", { from_currency: "btc", to_currency: "eth", from_amount: "1" } as any);
        await service.confirmInstantSwap({ user_id: "uid", quotation_id: "q1" } as any);
        await service.refreshInstantSwapQuote("uid", "q1", { amount: "1" } as any);
        await service.getSwapTransaction({ user_id: "uid", swap_transaction_id: "s1" } as any);
        await service.getSwapTransactionList("uid");

        await service.getMarketList();
        await service.getMarketTickers();
        await service.getSingleMarketTicker("btcngn");

        await service.getPaymentMethods({ token_symbol: "btc" } as any);
        await service.getPurchaseLimitForBuy({ currency_symbol: "btc" } as any);
        await service.getPurchaseLimitForSell({ token_symbol: "btc" } as any);
        await service.getPurchaseQuoteForBuy({ token: "btc", fiat_amount: "1000" } as any);
        await service.getPurchaseQuoteForSell({ token: "btc", token_amount: "1" } as any);

        expect(quidax.findSubAccountByEmail).toHaveBeenCalled();
        expect(quidax.createSubAccount).toHaveBeenCalled();
        expect(quidax.getAccountDetail).toHaveBeenCalled();
        expect(quidax.getUserWalletList).toHaveBeenCalled();
        expect(quidax.getUserWallet).toHaveBeenCalled();
        expect(quidax.getPaymentAddress).toHaveBeenCalled();
        expect(quidax.getPaymentAddressList).toHaveBeenCalled();
        expect(quidax.getPaymentAddressById).toHaveBeenCalled();
        expect(quidax.createPaymentAddress).toHaveBeenCalled();
        expect(quidax.verifyAddress).toHaveBeenCalled();
        expect(quidax.fetchDeposits).toHaveBeenCalled();
        expect(quidax.fetchDeposit).toHaveBeenCalled();
        expect(quidax.createWithdrawerRequest).toHaveBeenCalled();
        expect(quidax.cancelWithdrawerRequest).toHaveBeenCalled();
        expect(quidax.getWithdrawerList).toHaveBeenCalled();
        expect(quidax.getWithdrawerDetail).toHaveBeenCalled();
        expect(quidax.getWithdrawerByReference).toHaveBeenCalled();
        expect(quidax.getWithdrawerFees).toHaveBeenCalled();
        expect(quidax.buyOrSellOrderRequest).toHaveBeenCalled();
        expect(quidax.cancelBuyOrSellOrderRequest).toHaveBeenCalled();
        expect(quidax.getAllOrders).toHaveBeenCalled();
        expect(quidax.getOrderRecord).toHaveBeenCalled();
        expect(quidax.getOrderBookItemsForAMarket).toHaveBeenCalled();
        expect(quidax.instantOrdersRequery).toHaveBeenCalled();
        expect(quidax.createInstantSwapRequest).toHaveBeenCalled();
        expect(quidax.confirmInstantSwap).toHaveBeenCalled();
        expect(quidax.refreshInstantSwapQuote).toHaveBeenCalled();
        expect(quidax.getSwapTransaction).toHaveBeenCalled();
        expect(quidax.getSwapTransactionList).toHaveBeenCalled();
        expect(quidax.getMarketList).toHaveBeenCalled();
        expect(quidax.getMarketTickers).toHaveBeenCalled();
        expect(quidax.getSingleMarketTicker).toHaveBeenCalled();
        expect(quidax.getPaymentMethods).toHaveBeenCalled();
        expect(quidax.getPurchaseLimitForBuy).toHaveBeenCalled();
        expect(quidax.getPurchaseLimitForSell).toHaveBeenCalled();
        expect(quidax.getPurchaseQuoteForBuy).toHaveBeenCalled();
        expect(quidax.getPurchaseQuoteForSell).toHaveBeenCalled();
    });
});