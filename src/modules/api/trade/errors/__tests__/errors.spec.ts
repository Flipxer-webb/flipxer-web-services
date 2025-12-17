import { HttpStatus } from "@nestjs/common";
import {
    TradeErrorCode,
    BaseTradingException,
    WalletAddressNotFoundException,
    WalletSyncException,
    InsufficientBalanceException,
    AccountCreationException,
    IncompleteAccountSetupException,
    CryptoAccountNotFoundException,
    TransactionNotFoundException,
    TransactionCompletedException,
    TransactionCancelledException,
    TransactionExpiredException,
    InvalidTransactionAmountException,
    GeneralTransactionException,
    AssetNotFoundException,
    UnknownFeeStructureException,
    OutOfRangeException,
    InvalidNetworkException,
    InvalidAddressException,
    QuidaxApiException,
    FincraApiException,
    ProviderUnavailableException,
    LockAcquisitionException,
} from "../../errors";

describe("Trading Error Handling", () => {
    describe("TradeErrorCode", () => {
        it("should have unique codes for each error category", () => {
            // Wallet errors
            expect(TradeErrorCode.WALLET_ADDRESS_NOT_FOUND).toBe("TRADE_1001");
            expect(TradeErrorCode.WALLET_SYNC_FAILED).toBe("TRADE_1002");
            expect(TradeErrorCode.INSUFFICIENT_BALANCE).toBe("TRADE_1004");

            // Account errors
            expect(TradeErrorCode.ACCOUNT_CREATION_FAILED).toBe("TRADE_1101");
            expect(TradeErrorCode.INCOMPLETE_ACCOUNT_SETUP).toBe("TRADE_1102");

            // Transaction errors
            expect(TradeErrorCode.TRANSACTION_NOT_FOUND).toBe("TRADE_1201");
            expect(TradeErrorCode.TRANSACTION_ALREADY_COMPLETED).toBe("TRADE_1202");

            // External service errors
            expect(TradeErrorCode.QUIDAX_API_ERROR).toBe("TRADE_1501");
            expect(TradeErrorCode.FINCRA_API_ERROR).toBe("TRADE_1502");
        });
    });

    describe("Wallet Exceptions", () => {
        it("WalletAddressNotFoundException should have correct error code", () => {
            const error = new WalletAddressNotFoundException("Address not found", HttpStatus.NOT_FOUND);
            expect(error.errorCode).toBe(TradeErrorCode.WALLET_ADDRESS_NOT_FOUND);
            expect(error.name).toBe("WalletAddressNotFoundException");
        });

        it("WalletSyncException should include details", () => {
            const details = { userId: 1, currency: "BTC" };
            const error = new WalletSyncException("Failed to sync wallet", details);
            expect(error.errorCode).toBe(TradeErrorCode.WALLET_SYNC_FAILED);
            expect(error.details).toEqual(details);
            expect(error.getStatus()).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
        });

        it("InsufficientBalanceException should have default message", () => {
            const error = new InsufficientBalanceException();
            expect(error.getResponse()).toBeDefined();
            expect(error.errorCode).toBe(TradeErrorCode.INSUFFICIENT_BALANCE);
        });
    });

    describe("Account Exceptions", () => {
        it("AccountCreationException should have correct error code", () => {
            const error = new AccountCreationException("Failed to create", HttpStatus.BAD_GATEWAY);
            expect(error.errorCode).toBe(TradeErrorCode.ACCOUNT_CREATION_FAILED);
        });

        it("IncompleteAccountSetupException should have correct error code", () => {
            const error = new IncompleteAccountSetupException("Setup incomplete", HttpStatus.BAD_REQUEST);
            expect(error.errorCode).toBe(TradeErrorCode.INCOMPLETE_ACCOUNT_SETUP);
        });

        it("CryptoAccountNotFoundException should use NOT_FOUND status", () => {
            const error = new CryptoAccountNotFoundException();
            expect(error.getStatus()).toBe(HttpStatus.NOT_FOUND);
            expect(error.errorCode).toBe(TradeErrorCode.CRYPTO_ACCOUNT_NOT_FOUND);
        });
    });

    describe("Transaction Exceptions", () => {
        it("TransactionNotFoundException should have correct error code", () => {
            const error = new TransactionNotFoundException("Not found", HttpStatus.NOT_FOUND);
            expect(error.errorCode).toBe(TradeErrorCode.TRANSACTION_NOT_FOUND);
        });

        it("TransactionCompletedException should have correct error code", () => {
            const error = new TransactionCompletedException("Already done", HttpStatus.BAD_REQUEST);
            expect(error.errorCode).toBe(TradeErrorCode.TRANSACTION_ALREADY_COMPLETED);
        });

        it("TransactionCancelledException should include transaction details", () => {
            const details = { transactionId: "TXN-123", reason: "User requested" };
            const error = new TransactionCancelledException("Cancelled", details);
            expect(error.errorCode).toBe(TradeErrorCode.TRANSACTION_CANCELLED);
            expect(error.details).toEqual(details);
        });

        it("TransactionExpiredException should have default message", () => {
            const error = new TransactionExpiredException();
            expect(error.getResponse()).toBeDefined();
            expect(error.errorCode).toBe(TradeErrorCode.TRANSACTION_EXPIRED);
        });
    });

    describe("Validation Exceptions", () => {
        it("OutOfRangeException should have correct error code", () => {
            const error = new OutOfRangeException("Amount out of range", HttpStatus.BAD_REQUEST);
            expect(error.errorCode).toBe(TradeErrorCode.OUT_OF_RANGE);
        });

        it("InvalidNetworkException should include network details", () => {
            const details = { network: "unknown_network" };
            const error = new InvalidNetworkException("Invalid network", details);
            expect(error.errorCode).toBe(TradeErrorCode.INVALID_NETWORK);
            expect(error.details).toEqual(details);
        });

        it("InvalidAddressException should include address details", () => {
            const details = { address: "invalid", network: "btc" };
            const error = new InvalidAddressException("Invalid address format", details);
            expect(error.errorCode).toBe(TradeErrorCode.INVALID_ADDRESS);
            expect(error.getStatus()).toBe(HttpStatus.BAD_REQUEST);
        });
    });

    describe("External Service Exceptions", () => {
        it("QuidaxApiException should use BAD_GATEWAY status", () => {
            const details = { endpoint: "/api/withdraw", statusCode: 500 };
            const error = new QuidaxApiException("Quidax API failed", details);
            expect(error.errorCode).toBe(TradeErrorCode.QUIDAX_API_ERROR);
            expect(error.getStatus()).toBe(HttpStatus.BAD_GATEWAY);
        });

        it("FincraApiException should use BAD_GATEWAY status", () => {
            const error = new FincraApiException("Fincra transfer failed");
            expect(error.errorCode).toBe(TradeErrorCode.FINCRA_API_ERROR);
            expect(error.getStatus()).toBe(HttpStatus.BAD_GATEWAY);
        });

        it("ProviderUnavailableException should use SERVICE_UNAVAILABLE status", () => {
            const error = new ProviderUnavailableException();
            expect(error.errorCode).toBe(TradeErrorCode.PROVIDER_UNAVAILABLE);
            expect(error.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
        });
    });

    describe("Lock Exceptions", () => {
        it("LockAcquisitionException should use CONFLICT status", () => {
            const details = { lockKey: "deposit:123", waitedMs: 5000 };
            const error = new LockAcquisitionException("Lock timeout", details);
            expect(error.errorCode).toBe(TradeErrorCode.LOCK_ACQUISITION_FAILED);
            expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
        });
    });

    describe("BaseTradingException.toJSON()", () => {
        it("should produce correct JSON structure", () => {
            const error = new QuidaxApiException("API Error", { retryable: true });
            const json = error.toJSON();

            expect(json).toEqual({
                success: false,
                error: {
                    code: TradeErrorCode.QUIDAX_API_ERROR,
                    message: expect.any(String),
                    details: { retryable: true },
                },
                statusCode: HttpStatus.BAD_GATEWAY,
                timestamp: expect.any(String),
            });
        });
    });
});
