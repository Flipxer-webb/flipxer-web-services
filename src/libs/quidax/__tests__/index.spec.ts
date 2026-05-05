const mockMainAxios = jest.fn();
const mockRampAxios = jest.fn();
const mockAxiosCreate = jest.fn();
const mockIsAxiosError = jest.fn((value: unknown) =>
    Boolean(value && typeof value === "object" && "response" in value),
);

jest.mock("axios", () => ({
    __esModule: true,
    default: {
        create: mockAxiosCreate,
        isAxiosError: mockIsAxiosError,
    },
    create: mockAxiosCreate,
    isAxiosError: mockIsAxiosError,
}));

import { QuidaxLib } from "../index";
import {
    QuidaxAuthorizationError,
    QuidaxGenericError,
    QuidaxNotFoundError,
    QuidaxTooManyRequestError,
    QuidaxValidationError,
} from "../errors";

const VALID_USER_ID = "123e4567-e89b-12d3-a456-426614174000";

const makeResponse = (data?: any) => {
    const payload = data ?? { ok: true };

    return {
        data: {
            status: "success",
            message: "ok",
            data: payload,
        },
    };
};

describe("QuidaxLib", () => {
    let lib: QuidaxLib;
    let requestBudget: {
        assertAllowed: jest.Mock;
        noteThrottle: jest.Mock;
    };

    beforeEach(() => {
        jest.clearAllMocks();
        mockIsAxiosError.mockImplementation((value: unknown) =>
            Boolean(value && typeof value === "object" && "response" in value),
        );

        mockAxiosCreate
            .mockReset()
            .mockReturnValueOnce(mockMainAxios)
            .mockReturnValueOnce(mockRampAxios);

        requestBudget = {
            assertAllowed: jest.fn().mockResolvedValue(undefined),
            noteThrottle: jest.fn().mockResolvedValue(undefined),
        };

        lib = new QuidaxLib({
            baseURL: "https://quidax.example/api/v1",
            rampBaseURL: "https://ramp.example/api/v1/merchants",
            api_secret: "secret",
            requestBudget,
        } as any);
    });

    it("creates dedicated Axios clients for main and ramp APIs", () => {
        expect(mockAxiosCreate).toHaveBeenCalledTimes(2);
        expect(mockAxiosCreate).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                baseURL: "https://quidax.example/api/v1",
            }),
        );
        expect(mockAxiosCreate).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                baseURL: "https://ramp.example/api/v1/merchants",
            }),
        );
    });

    it("supports account and wallet endpoints", async () => {
        const scenarios: Array<{
            run: () => Promise<any>;
            expected: Record<string, any>;
        }> = [
            {
                run: () =>
                    lib.createSubAccount({ email: "new@user.com" } as any),
                expected: { url: "/users", method: "POST" },
            },
            {
                run: () => lib.getAllSubAccounts(),
                expected: { url: "/users", method: "GET" },
            },
            {
                run: () =>
                    lib.getAccountDetail({ user_id: VALID_USER_ID } as any),
                expected: { url: `/users/${VALID_USER_ID}`, method: "GET" },
            },
            {
                run: () =>
                    lib.getUserWalletList({ user_id: VALID_USER_ID } as any),
                expected: {
                    url: `/users/${VALID_USER_ID}/wallets`,
                    method: "GET",
                },
            },
            {
                run: () =>
                    lib.getUserWallet({
                        user_id: VALID_USER_ID,
                        currency: "btc",
                    } as any),
                expected: {
                    url: `/users/${VALID_USER_ID}/wallets/btc`,
                    method: "GET",
                },
            },
            {
                run: () =>
                    lib.getPaymentAddress({
                        user_id: VALID_USER_ID,
                        currency: "usdt",
                    } as any),
                expected: {
                    url: `/users/${VALID_USER_ID}/wallets/usdt/address`,
                    method: "GET",
                },
            },
            {
                run: () =>
                    lib.getPaymentAddressList({
                        user_id: VALID_USER_ID,
                        currency: "btc",
                    } as any),
                expected: {
                    url: `/users/${VALID_USER_ID}/wallets/btc/addresses`,
                    method: "GET",
                },
            },
            {
                run: () =>
                    lib.getPaymentAddressById({
                        user_id: VALID_USER_ID,
                        currency: "btc",
                        address_id: "address-1",
                    } as any),
                expected: {
                    url: `/users/${VALID_USER_ID}/wallets/btc/addresses/address-1`,
                    method: "GET",
                },
            },
            {
                run: () =>
                    lib.createPaymentAddress({
                        user_id: VALID_USER_ID,
                        currency: "eth",
                    } as any),
                expected: {
                    url: `/users/${VALID_USER_ID}/wallets/eth/addresses`,
                    method: "POST",
                },
            },
            {
                run: () =>
                    lib.verifyAddress({
                        currency: "btc",
                        address: "bc1qaddr",
                        network: "btc",
                    } as any),
                expected: {
                    url: "/btc/bc1qaddr/validate_address",
                    method: "GET",
                    params: { network: "btc" },
                },
            },
        ];

        for (const scenario of scenarios) {
            mockMainAxios.mockResolvedValueOnce(makeResponse());
            const result = await scenario.run();

            expect(result).toEqual(makeResponse().data);
            expect(mockMainAxios).toHaveBeenLastCalledWith(
                expect.objectContaining(scenario.expected),
            );
        }
    });

    it("supports withdrawal, order, swap, deposit and market endpoints", async () => {
        const scenarios: Array<{
            run: () => Promise<any>;
            expected: Record<string, any>;
        }> = [
            {
                run: () =>
                    lib.createWithdrawerRequest({
                        user_id: VALID_USER_ID,
                        currency: "btc",
                        amount: 1,
                    } as any),
                expected: {
                    url: `/users/${VALID_USER_ID}/withdraws`,
                    method: "POST",
                },
            },
            {
                run: () =>
                    lib.cancelWithdrawerRequest({
                        user_id: VALID_USER_ID,
                        withdrawal_id: "wd-1",
                    } as any),
                expected: {
                    url: `/users/${VALID_USER_ID}/withdraws/wd-1/cancel`,
                    method: "POST",
                },
            },
            {
                run: () =>
                    lib.getWithdrawerList(VALID_USER_ID, {
                        state: "pending",
                    } as any),
                expected: {
                    url: `/users/${VALID_USER_ID}/withdraws`,
                    method: "GET",
                },
            },
            {
                run: () =>
                    lib.getWithdrawerDetail({
                        user_id: VALID_USER_ID,
                        withdrawal_id: "wd-2",
                    } as any),
                expected: {
                    url: `/users/${VALID_USER_ID}/withdraws/wd-2`,
                    method: "GET",
                },
            },
            {
                run: () =>
                    lib.getWithdrawerByReference({
                        user_id: VALID_USER_ID,
                        reference: "ref-99",
                    } as any),
                expected: {
                    url: `/users/${VALID_USER_ID}/withdraws/reference/ref-99`,
                    method: "GET",
                },
            },
            {
                run: () => lib.getWithdrawerFees({ currency: "btc" } as any),
                expected: { url: "/fee", method: "GET" },
            },
            {
                run: () =>
                    lib.buyOrSellOrderRequest(VALID_USER_ID, {
                        market: "btcngn",
                        side: "buy",
                    } as any),
                expected: {
                    url: `/users/${VALID_USER_ID}/orders`,
                    method: "POST",
                },
            },
            {
                run: () =>
                    lib.cancelBuyOrSellOrderRequest(VALID_USER_ID, {
                        order_id: "ord-1",
                    } as any),
                expected: {
                    url: `/users/${VALID_USER_ID}/orders/ord-1/cancel`,
                    method: "POST",
                },
            },
            {
                run: () =>
                    lib.getAllOrders(VALID_USER_ID, { state: "done" } as any),
                expected: {
                    url: `/users/${VALID_USER_ID}/orders`,
                    method: "GET",
                },
            },
            {
                run: () =>
                    lib.getOrderRecord({
                        user_id: VALID_USER_ID,
                        order_id: "ord-2",
                    } as any),
                expected: {
                    url: `/users/${VALID_USER_ID}/orders/ord-2`,
                    method: "GET",
                },
            },
            {
                run: () =>
                    lib.instantOrdersRequery({
                        user_id: VALID_USER_ID,
                        instant_order_id: "inst-1",
                    } as any),
                expected: {
                    url: `/users/${VALID_USER_ID}/instant_orders/inst-1`,
                    method: "GET",
                },
            },
            {
                run: () =>
                    lib.createInstantSwapRequest(VALID_USER_ID, {
                        from_currency: "btc",
                        to_currency: "usdt",
                        from_amount: "1",
                    } as any),
                expected: {
                    url: `/users/${VALID_USER_ID}/swap_quotation`,
                    method: "POST",
                },
            },
            {
                run: () =>
                    lib.confirmInstantSwap({
                        user_id: VALID_USER_ID,
                        quotation_id: "quote-1",
                    } as any),
                expected: {
                    url: `/users/${VALID_USER_ID}/swap_quotation/quote-1/confirm`,
                    method: "POST",
                },
            },
            {
                run: () =>
                    lib.refreshInstantSwapQuote(VALID_USER_ID, "quote-1", {
                        amount: "1",
                    } as any),
                expected: {
                    url: `/users/${VALID_USER_ID}/swap_quotation/quote-1/refresh`,
                    method: "POST",
                },
            },
            {
                run: () =>
                    lib.getSwapTransaction({
                        user_id: VALID_USER_ID,
                        swap_transaction_id: "swap-1",
                    } as any),
                expected: {
                    url: `/users/${VALID_USER_ID}/swap_transactions/swap-1`,
                    method: "GET",
                },
            },
            {
                run: () => lib.getSwapTransactionList(VALID_USER_ID),
                expected: {
                    url: `/users/${VALID_USER_ID}/swap_transactions`,
                    method: "GET",
                },
            },
            {
                run: () =>
                    lib.fetchDeposits({
                        user_id: VALID_USER_ID,
                        currency: "btc",
                        state: "done",
                    } as any),
                expected: {
                    url: `/users/${VALID_USER_ID}/deposits`,
                    method: "GET",
                },
            },
            {
                run: () =>
                    lib.fetchDeposit({
                        user_id: VALID_USER_ID,
                        deposit_id: "dep-1",
                    } as any),
                expected: {
                    url: `/users/${VALID_USER_ID}/deposits/dep-1`,
                    method: "GET",
                },
            },
            {
                run: () => lib.getMarketList(),
                expected: { url: "/markets", method: "GET" },
            },
            {
                run: () => lib.getMarketTickers(),
                expected: { url: "/markets/tickers", method: "GET" },
            },
            {
                run: () => lib.getSingleMarketTicker("btcngn"),
                expected: { url: "/markets/tickers/btcngn", method: "GET" },
            },
            {
                run: () =>
                    lib.getOrderBookItemsForAMarket({
                        currency: "btcngn",
                        ask_limit: 10,
                        bids_limit: 10,
                    } as any),
                expected: { url: "/markets/btcngn/order_book", method: "GET" },
            },
        ];

        for (const scenario of scenarios) {
            mockMainAxios.mockResolvedValueOnce(makeResponse());
            const result = await scenario.run();

            expect(result).toEqual(makeResponse().data);
            expect(mockMainAxios).toHaveBeenLastCalledWith(
                expect.objectContaining(scenario.expected),
            );
        }
    });

    it("supports ramp endpoints", async () => {
        const scenarios: Array<{
            run: () => Promise<any>;
            expected: Record<string, any>;
        }> = [
            {
                run: () => lib.getPaymentMethods({ type: "bank" } as any),
                expected: { url: "/payment_methods", method: "GET" },
            },
            {
                run: () =>
                    lib.getPurchaseLimitForBuy({ currency: "ngn" } as any),
                expected: { url: "/purchase_limits/buy", method: "GET" },
            },
            {
                run: () =>
                    lib.getPurchaseLimitForSell({ currency: "btc" } as any),
                expected: { url: "/purchase_limits/sell", method: "GET" },
            },
            {
                run: () =>
                    lib.getPurchaseQuoteForBuy({
                        amount: "1000",
                        fiat_currency: "ngn",
                    } as any),
                expected: { url: "/purchase_quotes/buy", method: "GET" },
            },
            {
                run: () =>
                    lib.getPurchaseQuoteForSell({
                        amount: "1",
                        currency: "btc",
                    } as any),
                expected: { url: "/purchase_quotes/sell", method: "GET" },
            },
        ];

        for (const scenario of scenarios) {
            mockRampAxios.mockResolvedValueOnce(makeResponse());
            const result = await scenario.run();

            expect(result).toEqual(makeResponse().data);
            expect(mockRampAxios).toHaveBeenLastCalledWith(
                expect.objectContaining(scenario.expected),
            );
        }
    });

    it("validates user_id and path segments before sending requests", async () => {
        await expect(
            lib.getAccountDetail({ user_id: "invalid-user-id" } as any),
        ).rejects.toBeInstanceOf(QuidaxValidationError);

        await expect(
            lib.getUserWallet({
                user_id: VALID_USER_ID,
                currency: "btc/usdt",
            } as any),
        ).rejects.toBeInstanceOf(QuidaxValidationError);

        mockMainAxios.mockResolvedValueOnce(makeResponse());
        await expect(
            lib.getAccountDetail({ user_id: "me" } as any),
        ).resolves.toEqual(makeResponse().data);
    });

    it("finds sub-account by email and returns null for lookup errors", async () => {
        mockMainAxios.mockResolvedValueOnce(
            makeResponse([
                { id: "u1", email: "first@example.com" },
                { id: "u2", email: "second@example.com" },
            ]),
        );

        await expect(
            lib.findSubAccountByEmail("SECOND@example.com"),
        ).resolves.toEqual(expect.objectContaining({ id: "u2" }));

        mockMainAxios.mockRejectedValueOnce(new Error("network"));
        await expect(
            lib.findSubAccountByEmail("missing@example.com"),
        ).resolves.toBeNull();
    });

    it("maps Quidax API errors to specific exception classes", async () => {
        mockMainAxios.mockRejectedValueOnce({
            response: { status: 401, data: { message: "unauthorized" } },
            config: { url: "/users" },
            message: "401",
        });
        await expect(lib.getAllSubAccounts()).rejects.toBeInstanceOf(
            QuidaxAuthorizationError,
        );

        mockMainAxios.mockRejectedValueOnce({
            response: {
                status: 400,
                data: { message: "bad request", data: { code: "E0101" } },
            },
            config: { url: "/users" },
            message: "400",
        });
        await expect(lib.getAllSubAccounts()).rejects.toMatchObject({
            name: "QuidaxValidationError",
            code: "E0101",
        });

        mockMainAxios.mockRejectedValueOnce({
            response: { status: 404, data: { message: "not found" } },
            config: { url: "/users" },
            message: "404",
        });
        await expect(lib.getAllSubAccounts()).rejects.toBeInstanceOf(
            QuidaxNotFoundError,
        );

        mockMainAxios.mockRejectedValueOnce({
            response: { status: 429, data: { message: "too many" } },
            config: { url: "/users" },
            message: "429",
        });
        await expect(lib.getAllSubAccounts()).rejects.toBeInstanceOf(
            QuidaxTooManyRequestError,
        );

        mockMainAxios.mockRejectedValueOnce({
            response: {
                status: 500,
                data: { message: "boom" },
                statusText: "Server Error",
            },
            config: { url: "/users" },
            message: "500",
        });
        await expect(lib.getAllSubAccounts()).rejects.toBeInstanceOf(
            QuidaxGenericError,
        );
    });

    it("blocks before sending requests when the shared budget is exhausted", async () => {
        requestBudget.assertAllowed.mockRejectedValueOnce(
            new QuidaxTooManyRequestError("cooldown active"),
        );

        await expect(lib.getAllSubAccounts()).rejects.toBeInstanceOf(
            QuidaxTooManyRequestError,
        );
        expect(requestBudget.assertAllowed).toHaveBeenCalledWith("main");
        expect(mockMainAxios).not.toHaveBeenCalled();
    });

    it("uses the wallet-address budget bucket for address generation", async () => {
        mockMainAxios.mockResolvedValueOnce(makeResponse());

        await lib.createPaymentAddress({
            user_id: VALID_USER_ID,
            currency: "eth",
        } as any);

        expect(requestBudget.assertAllowed).toHaveBeenCalledWith(
            "wallet-address",
        );
    });

    it("records shared cooldown state when Quidax throttles a request", async () => {
        mockMainAxios.mockRejectedValueOnce({
            response: { status: 429, data: { message: "too many" } },
            config: { url: "/users" },
            message: "429",
        });

        await expect(lib.getAllSubAccounts()).rejects.toBeInstanceOf(
            QuidaxTooManyRequestError,
        );
        expect(requestBudget.noteThrottle).toHaveBeenCalledWith("main");
    });

    it("raises generic errors for empty payload responses across endpoints", async () => {
        const mainEndpoints: Array<() => Promise<any>> = [
            () => lib.createSubAccount({ email: "new@user.com" } as any),
            () => lib.getAllSubAccounts(),
            () => lib.getAccountDetail({ user_id: VALID_USER_ID } as any),
            () => lib.getUserWalletList({ user_id: VALID_USER_ID } as any),
            () =>
                lib.getUserWallet({
                    user_id: VALID_USER_ID,
                    currency: "btc",
                } as any),
            () =>
                lib.getPaymentAddress({
                    user_id: VALID_USER_ID,
                    currency: "btc",
                } as any),
            () =>
                lib.createPaymentAddress({
                    user_id: VALID_USER_ID,
                    currency: "btc",
                } as any),
            () =>
                lib.verifyAddress({
                    currency: "btc",
                    address: "bc1qaddr",
                } as any),
            () =>
                lib.createWithdrawerRequest({
                    user_id: VALID_USER_ID,
                    currency: "btc",
                    amount: 1,
                } as any),
            () =>
                lib.cancelWithdrawerRequest({
                    user_id: VALID_USER_ID,
                    withdrawal_id: "wd-1",
                } as any),
            () =>
                lib.getWithdrawerList(VALID_USER_ID, {
                    state: "pending",
                } as any),
            () =>
                lib.getWithdrawerDetail({
                    user_id: VALID_USER_ID,
                    withdrawal_id: "wd-1",
                } as any),
            () =>
                lib.getWithdrawerByReference({
                    user_id: VALID_USER_ID,
                    reference: "ref-1",
                } as any),
            () => lib.getWithdrawerFees({ currency: "btc" } as any),
            () =>
                lib.buyOrSellOrderRequest(VALID_USER_ID, {
                    side: "buy",
                    market: "btcngn",
                } as any),
            () => lib.getAllOrders(VALID_USER_ID, { state: "done" } as any),
            () =>
                lib.getOrderRecord({
                    user_id: VALID_USER_ID,
                    order_id: "ord-1",
                } as any),
            () =>
                lib.instantOrdersRequery({
                    user_id: VALID_USER_ID,
                    instant_order_id: "inst-1",
                } as any),
            () =>
                lib.createInstantSwapRequest(VALID_USER_ID, {
                    from_currency: "btc",
                    to_currency: "usdt",
                } as any),
            () =>
                lib.confirmInstantSwap({
                    user_id: VALID_USER_ID,
                    quotation_id: "q-1",
                } as any),
            () =>
                lib.refreshInstantSwapQuote(VALID_USER_ID, "q-1", {
                    from_amount: "1",
                } as any),
            () =>
                lib.getSwapTransaction({
                    user_id: VALID_USER_ID,
                    swap_transaction_id: "swap-1",
                } as any),
            () => lib.getSwapTransactionList(VALID_USER_ID),
            () =>
                lib.fetchDeposits({
                    user_id: VALID_USER_ID,
                    currency: "btc",
                } as any),
            () =>
                lib.fetchDeposit({
                    user_id: VALID_USER_ID,
                    deposit_id: "dep-1",
                } as any),
            () => lib.getMarketTickers(),
            () => lib.getSingleMarketTicker("btcngn"),
            () =>
                lib.getOrderBookItemsForAMarket({
                    currency: "btcngn",
                    ask_limit: 10,
                    bids_limit: 10,
                } as any),
        ];

        for (const run of mainEndpoints) {
            mockMainAxios.mockResolvedValueOnce({ data: undefined });
            await expect(run()).rejects.toBeInstanceOf(QuidaxGenericError);
        }

        const rampEndpoints: Array<() => Promise<any>> = [
            () => lib.getPaymentMethods({ type: "bank" } as any),
            () => lib.getPurchaseLimitForBuy({ currency: "ngn" } as any),
            () => lib.getPurchaseLimitForSell({ currency: "btc" } as any),
            () =>
                lib.getPurchaseQuoteForBuy({
                    fiat_currency: "ngn",
                    amount: "100",
                } as any),
            () =>
                lib.getPurchaseQuoteForSell({
                    currency: "btc",
                    amount: "1",
                } as any),
        ];

        for (const run of rampEndpoints) {
            mockRampAxios.mockResolvedValueOnce({ data: undefined });
            await expect(run()).rejects.toBeInstanceOf(QuidaxGenericError);
        }
    });

    it("throws a generic error when downstream response payload is missing", async () => {
        mockMainAxios.mockResolvedValueOnce({ data: undefined });

        await expect(lib.getMarketList()).rejects.toBeInstanceOf(
            QuidaxGenericError,
        );
    });
});
