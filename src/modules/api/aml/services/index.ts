import { Injectable, HttpStatus, Logger } from "@nestjs/common";
import { AmlBotLib } from "@/libs/amlbot";
import * as AML from "@/libs/amlbot";
import { buildResponse } from "@/utils/api-response-util";
import { APIServiceHttpException } from "@/utils/errors";
import { ErrorCode } from "@/core/exception/error-codes";
import {
    CheckAddressDto,
    CheckTransactionDto,
    RecheckDto,
    InvestigateAddressDto,
    GetHistoryDto,
} from "../dtos";

@Injectable()
export class AmlService {
    private readonly logger = new Logger(AmlService.name);

    constructor(private readonly amlBot: AmlBotLib) {}

    async checkAddress(dto: CheckAddressDto) {
        try {
            const result = await this.amlBot.checkAddress({
                hash: dto.hash,
                asset: dto.asset,
            });

            // Handle async flow — some chains return pending status
            if (result.data?.status === "pending") {
                return buildResponse({
                    message: "AML check initiated. Use the uid to poll for results.",
                    data: {
                        uid: result.data.uid,
                        status: "pending",
                        address: result.data.address,
                        asset: result.data.asset,
                    },
                });
            }

            return buildResponse({
                message: "Address AML check completed",
                data: {
                    riskscore: result.data.riskscore,
                    signals: result.data.signals,
                    address: result.data.address,
                    asset: result.data.asset,
                    counterparty: result.data.counterparty,
                    blackListsConnections: result.data.blackListsConnections,
                    hasBlackListFlag: result.data.hasBlackListFlag,
                    pdfReport: result.data.pdfReport,
                    timestamp: result.data.timestamp,
                    balance: result.balance,
                },
            });
        } catch (error) {
            this.handleAmlError(error, "address check");
        }
    }

    async checkTransaction(dto: CheckTransactionDto) {
        try {
            const result = await this.amlBot.checkTransaction({
                hash: dto.hash,
                address: dto.address,
                direction: dto.direction,
                asset: dto.asset,
            });

            if (result.data?.status === "pending") {
                return buildResponse({
                    message: "AML transaction check initiated. Use the uid to poll for results.",
                    data: {
                        uid: result.data.uid,
                        status: "pending",
                        tx: result.data.tx,
                        asset: result.data.asset,
                    },
                });
            }

            const txData = result.data;
            return buildResponse({
                message: "Transaction AML check completed",
                data: {
                    riskscore: txData.riskscore,
                    signals: txData.signals,
                    address: txData.address,
                    tx: txData.tx,
                    amount: txData.amount,
                    direction: txData.direction,
                    risky_volume: txData.risky_volume,
                    risky_volume_fiat: txData.risky_volume_fiat,
                    asset: txData.asset,
                    counterparty: txData.counterparty,
                    blackListsConnections: txData.blackListsConnections,
                    hasBlackListFlag: txData.hasBlackListFlag,
                    tokenDetails: txData.tokenDetails,
                    pdfReport: txData.pdfReport,
                    timestamp: txData.timestamp,
                    balance: result.balance,
                },
            });
        } catch (error) {
            this.handleAmlError(error, "transaction check");
        }
    }

    async recheck(dto: RecheckDto) {
        try {
            const result = await this.amlBot.recheck({ uid: dto.uid });

            if (result.data?.status === "pending") {
                return buildResponse({
                    message: "Check is still pending. Try again shortly.",
                    data: {
                        uid: result.data.uid,
                        status: "pending",
                    },
                });
            }

            return buildResponse({
                message: "AML recheck completed",
                data: {
                    riskscore: result.data.riskscore,
                    signals: result.data.signals,
                    address: result.data.address,
                    asset: result.data.asset,
                    counterparty: result.data.counterparty,
                    blackListsConnections: result.data.blackListsConnections,
                    hasBlackListFlag: result.data.hasBlackListFlag,
                    pdfReport: result.data.pdfReport,
                    timestamp: result.data.timestamp,
                    balance: result.balance,
                },
            });
        } catch (error) {
            this.handleAmlError(error, "recheck");
        }
    }

    async investigate(dto: InvestigateAddressDto) {
        try {
            const result = await this.amlBot.investigate({
                hash: dto.hash,
                asset: dto.asset,
                expanded: 1,
                ...(dto.tokenData && { tokenData: dto.tokenData }),
            });

            return buildResponse({
                message: "AML investigation completed",
                data: {
                    riskscore: result.data.riskscore,
                    connections: result.data.indirects?.connections,
                    address: result.data.address,
                    asset: result.data.asset,
                    counterparty: result.data.counterparty,
                    identifier: result.data.identifier,
                    timestamp: result.data.timestamp,
                    balance: result.balance,
                },
            });
        } catch (error) {
            this.handleAmlError(error, "investigation");
        }
    }

    async getHistory(dto?: GetHistoryDto) {
        try {
            const result = await this.amlBot.getHistory({
                page: dto?.page,
                address: dto?.address,
                tx: dto?.tx,
                asset: dto?.asset,
            });

            return buildResponse({
                message: "AML check history retrieved",
                data: {
                    checks: result.data,
                    totalCount: result.totalCount,
                    pageLimit: result.pageLimit,
                    balance: result.balance,
                },
            });
        } catch (error) {
            this.handleAmlError(error, "history retrieval");
        }
    }

    async getSupportedCoins() {
        try {
            const result = await this.amlBot.getSupportedCoins();
            return buildResponse({
                message: "Supported coins retrieved",
                data: result,
            });
        } catch (error) {
            this.handleAmlError(error, "supported coins retrieval");
        }
    }

    private handleAmlError(error: any, operation: string): never {
        if (error instanceof AML.AmlBotAuthorizationError) {
            this.logger.error(`AMLBot authorization failed during ${operation}: ${error.message}`);
            throw new APIServiceHttpException(
                { message: "AML service authorization failed", code: ErrorCode.EXTERNAL_SERVICE_ERROR },
                HttpStatus.BAD_GATEWAY
            );
        }

        if (error instanceof AML.AmlBotValidationError) {
            this.logger.warn(`AMLBot validation error during ${operation}: ${error.message}`);
            throw new APIServiceHttpException(
                { message: error.message || "Invalid AML check request", code: ErrorCode.VALIDATION_ERROR },
                HttpStatus.BAD_REQUEST
            );
        }

        if (error instanceof AML.AmlBotInsufficientBalanceError) {
            this.logger.error(`AMLBot insufficient balance during ${operation}`);
            throw new APIServiceHttpException(
                { message: "AML service balance depleted", code: ErrorCode.EXTERNAL_SERVICE_ERROR },
                HttpStatus.SERVICE_UNAVAILABLE
            );
        }

        if (error instanceof AML.AmlBotNetworkError) {
            this.logger.error(`AMLBot network error during ${operation}: ${error.message}`);
            throw new APIServiceHttpException(
                { message: "AML service temporarily unavailable", code: ErrorCode.EXTERNAL_SERVICE_ERROR },
                HttpStatus.BAD_GATEWAY
            );
        }

        if (error instanceof AML.AmlBotRateLimitError) {
            this.logger.warn(`AMLBot rate limited during ${operation}`);
            throw new APIServiceHttpException(
                { message: "AML service rate limit exceeded. Try again later.", code: ErrorCode.RATE_LIMITED },
                HttpStatus.TOO_MANY_REQUESTS
            );
        }

        this.logger.error(`AMLBot unexpected error during ${operation}:`, error);
        throw new APIServiceHttpException(
            { message: "AML check failed", code: ErrorCode.EXTERNAL_SERVICE_ERROR },
            HttpStatus.BAD_GATEWAY
        );
    }
}
