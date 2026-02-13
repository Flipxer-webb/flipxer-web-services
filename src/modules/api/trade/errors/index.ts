import { HttpException, HttpStatus } from "@nestjs/common";

/**
 * Error codes for trading module exceptions
 * These codes help clients identify and handle specific error conditions
 */
export enum TradeErrorCode {
    // Wallet errors (1000-1099)
    WALLET_ADDRESS_NOT_FOUND = "TRADE_1001",
    WALLET_SYNC_FAILED = "TRADE_1002",
    WALLET_CREATION_FAILED = "TRADE_1003",
    INSUFFICIENT_BALANCE = "TRADE_1004",

    // Account errors (1100-1199)
    ACCOUNT_CREATION_FAILED = "TRADE_1101",
    INCOMPLETE_ACCOUNT_SETUP = "TRADE_1102",
    CRYPTO_ACCOUNT_NOT_FOUND = "TRADE_1103",

    // Transaction errors (1200-1299)
    TRANSACTION_NOT_FOUND = "TRADE_1201",
    TRANSACTION_ALREADY_COMPLETED = "TRADE_1202",
    TRANSACTION_CANCELLED = "TRADE_1203",
    TRANSACTION_FAILED = "TRADE_1204",
    INVALID_TRANSACTION_AMOUNT = "TRADE_1205",
    TRANSACTION_EXPIRED = "TRADE_1206",

    // Asset/Rate errors (1300-1399)
    ASSET_NOT_FOUND = "TRADE_1301",
    CRYPTO_RATE_NOT_FOUND = "TRADE_1302",
    CRYPTO_FEE_NOT_FOUND = "TRADE_1303",
    UNKNOWN_FEE_STRUCTURE = "TRADE_1304",

    // Validation errors (1400-1499)
    OUT_OF_RANGE = "TRADE_1401",
    INVALID_NETWORK = "TRADE_1402",
    INVALID_ADDRESS = "TRADE_1403",

    // External service errors (1500-1599)
    QUIDAX_API_ERROR = "TRADE_1501",
    FINCRA_API_ERROR = "TRADE_1502",
    PROVIDER_UNAVAILABLE = "TRADE_1503",

    // General errors (1900-1999)
    GENERAL_TRANSACTION_ERROR = "TRADE_1901",
    LOCK_ACQUISITION_FAILED = "TRADE_1902",
    RATE_LIMIT_EXCEEDED = "TRADE_1903",
}

/**
 * Standard error response structure for trading module
 */
export interface TradeErrorResponse {
    success: false;
    error: {
        code: TradeErrorCode;
        message: string;
        details?: Record<string, unknown>;
    };
    statusCode: number;
    timestamp: string;
}

/**
 * Base exception class for all trading module exceptions
 * Provides consistent error structure with error codes
 */
export abstract class BaseTradingException extends HttpException {
    abstract readonly errorCode: TradeErrorCode;

    constructor(
        message: string,
        statusCode: HttpStatus = HttpStatus.BAD_REQUEST,
        public readonly details?: Record<string, unknown>
    ) {
        const response: TradeErrorResponse = {
            success: false,
            error: {
                code: (null as unknown) as TradeErrorCode, // Will be set in derived class
                message,
                details,
            },
            statusCode,
            timestamp: new Date().toISOString(),
        };
        super(response, statusCode);
    }

    getErrorCode(): TradeErrorCode {
        return this.errorCode;
    }

    toJSON(): TradeErrorResponse {
        return {
            success: false,
            error: {
                code: this.errorCode,
                message: this.message,
                details: this.details,
            },
            statusCode: this.getStatus(),
            timestamp: new Date().toISOString(),
        };
    }
}

// =============================================================================
// WALLET EXCEPTIONS
// =============================================================================

export class WalletAddressNotFoundException extends HttpException {
    name = "WalletAddressNotFoundException";
    readonly errorCode = TradeErrorCode.WALLET_ADDRESS_NOT_FOUND;
}

export class WalletSyncException extends BaseTradingException {
    name = "WalletSyncException";
    readonly errorCode = TradeErrorCode.WALLET_SYNC_FAILED;

    constructor(message: string, details?: Record<string, unknown>) {
        super(message, HttpStatus.INTERNAL_SERVER_ERROR, details);
    }
}

export class InsufficientBalanceException extends BaseTradingException {
    name = "InsufficientBalanceException";
    readonly errorCode = TradeErrorCode.INSUFFICIENT_BALANCE;

    constructor(
        message: string = "Insufficient balance for this transaction",
        details?: Record<string, unknown>
    ) {
        super(message, HttpStatus.BAD_REQUEST, details);
    }
}

// =============================================================================
// ACCOUNT EXCEPTIONS
// =============================================================================

export class AccountCreationException extends HttpException {
    name = "AccountCreationException";
    readonly errorCode = TradeErrorCode.ACCOUNT_CREATION_FAILED;
}

export class IncompleteAccountSetupException extends HttpException {
    name = "IncompleteAccountSetupException";
    readonly errorCode = TradeErrorCode.INCOMPLETE_ACCOUNT_SETUP;
}

export class CryptoAccountNotFoundException extends BaseTradingException {
    name = "CryptoAccountNotFoundException";
    readonly errorCode = TradeErrorCode.CRYPTO_ACCOUNT_NOT_FOUND;

    constructor(
        message: string = "User crypto account not found",
        details?: Record<string, unknown>
    ) {
        super(message, HttpStatus.NOT_FOUND, details);
    }
}

// =============================================================================
// TRANSACTION EXCEPTIONS
// =============================================================================

export class TransactionNotFoundException extends HttpException {
    name = "TransactionNotFoundException";
    readonly errorCode = TradeErrorCode.TRANSACTION_NOT_FOUND;
}

export class TransactionCompletedException extends HttpException {
    name = "TransactionCompletedException";
    readonly errorCode = TradeErrorCode.TRANSACTION_ALREADY_COMPLETED;
}

export class TransactionCancelledException extends BaseTradingException {
    name = "TransactionCancelledException";
    readonly errorCode = TradeErrorCode.TRANSACTION_CANCELLED;

    constructor(message: string, details?: Record<string, unknown>) {
        super(message, HttpStatus.BAD_REQUEST, details);
    }
}

export class TransactionExpiredException extends BaseTradingException {
    name = "TransactionExpiredException";
    readonly errorCode = TradeErrorCode.TRANSACTION_EXPIRED;

    constructor(
        message: string = "Transaction quote has expired",
        details?: Record<string, unknown>
    ) {
        super(message, HttpStatus.BAD_REQUEST, details);
    }
}

export class InvalidTransactionAmountException extends HttpException {
    name = "InvalidTransactionAmountException";
    readonly errorCode = TradeErrorCode.INVALID_TRANSACTION_AMOUNT;
}

export class GeneralTransactionException extends HttpException {
    name = "GeneralTransactionException";
    readonly errorCode = TradeErrorCode.GENERAL_TRANSACTION_ERROR;
}

// =============================================================================
// ASSET/RATE EXCEPTIONS
// =============================================================================

export class AssetNotFoundException extends HttpException {
    name = "AssetNotFoundException";
    readonly errorCode = TradeErrorCode.ASSET_NOT_FOUND;
}

export class UnknownFeeStructureException extends HttpException {
    name = "UnknownFeeStructureException";
    readonly errorCode = TradeErrorCode.UNKNOWN_FEE_STRUCTURE;
}

// =============================================================================
// VALIDATION EXCEPTIONS
// =============================================================================

export class OutOfRangeException extends HttpException {
    name = "OutOfRangeException";
    readonly errorCode = TradeErrorCode.OUT_OF_RANGE;
}

export class InvalidNetworkException extends BaseTradingException {
    name = "InvalidNetworkException";
    readonly errorCode = TradeErrorCode.INVALID_NETWORK;

    constructor(message: string, details?: Record<string, unknown>) {
        super(message, HttpStatus.BAD_REQUEST, details);
    }
}

export class InvalidAddressException extends BaseTradingException {
    name = "InvalidAddressException";
    readonly errorCode = TradeErrorCode.INVALID_ADDRESS;

    constructor(message: string, details?: Record<string, unknown>) {
        super(message, HttpStatus.BAD_REQUEST, details);
    }
}

// =============================================================================
// EXTERNAL SERVICE EXCEPTIONS
// =============================================================================

export class QuidaxApiException extends BaseTradingException {
    name = "QuidaxApiException";
    readonly errorCode = TradeErrorCode.QUIDAX_API_ERROR;

    constructor(message: string, details?: Record<string, unknown>) {
        super(message, HttpStatus.BAD_GATEWAY, details);
    }
}

export class FincraApiException extends BaseTradingException {
    name = "FincraApiException";
    readonly errorCode = TradeErrorCode.FINCRA_API_ERROR;

    constructor(message: string, details?: Record<string, unknown>) {
        super(message, HttpStatus.BAD_GATEWAY, details);
    }
}

export class ProviderUnavailableException extends BaseTradingException {
    name = "ProviderUnavailableException";
    readonly errorCode = TradeErrorCode.PROVIDER_UNAVAILABLE;

    constructor(
        message: string = "Trading provider is temporarily unavailable",
        details?: Record<string, unknown>
    ) {
        super(message, HttpStatus.SERVICE_UNAVAILABLE, details);
    }
}

// =============================================================================
// LOCK EXCEPTIONS
// =============================================================================

export class LockAcquisitionException extends BaseTradingException {
    name = "LockAcquisitionException";
    readonly errorCode = TradeErrorCode.LOCK_ACQUISITION_FAILED;

    constructor(
        message: string = "Failed to acquire lock for operation",
        details?: Record<string, unknown>
    ) {
        super(message, HttpStatus.CONFLICT, details);
    }
}

// =============================================================================
// RATE LIMIT EXCEPTIONS
// =============================================================================

export class RateLimitExceededException extends BaseTradingException {
    name = "RateLimitExceededException";
    readonly errorCode = TradeErrorCode.RATE_LIMIT_EXCEEDED;

    constructor(
        message: string = "Rate limit exceeded",
        details?: Record<string, unknown>
    ) {
        super(message, HttpStatus.TOO_MANY_REQUESTS, details);
    }
}
