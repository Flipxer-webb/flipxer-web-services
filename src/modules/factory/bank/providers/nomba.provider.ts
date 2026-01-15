import { HttpStatus } from "@nestjs/common";
import { NombaLib, NombaBankListResponse } from "@/libs/nomba";
import { PrismaService } from "@/modules/core/prisma/services";
import logger from "moment-logger";
import { generateId } from "@/utils";
import {
    PaymentMethod,
    TransactionFlow,
    TransactionStatus,
    TransactionType,
} from "@prisma/client";
import {
    TNomba,
    NombaUserRecord,
    NombaResolveBankAccountOptions,
    NombaResolveBankAccountResponse,
    NombaInitializeTransferOptions,
    NombaVirtualAccountOptions,
} from "../types/nomba";
import * as e from "../errors/nomba.error";
import { TransactionShortDescription } from "@/modules/api/transactions/types";

export class NombaBank implements TNomba.INombaBank {
    constructor(private nomba: NombaLib, private prisma: PrismaService) { }

    /**
     * Get list of Nigerian banks
     */
    async getBanks(): Promise<NombaBankListResponse> {
        try {
            const banks = await this.nomba.getBanks();
            if (!banks || banks.code !== "00") {
                throw new e.NOMBABankException(
                    "Failed to fetch banks",
                    HttpStatus.BAD_REQUEST
                );
            }
            return banks;
        } catch (error) {
            logger.error(error, "****GET BANKS****** NOMBA");
            if (error instanceof e.NOMBABankException) {
                throw error;
            }
            throw new e.NOMBABankException(
                error instanceof Error
                    ? error.message
                    : "Failed to fetch banks",
                HttpStatus.BAD_REQUEST
            );
        }
    }

    /**
     * Resolve/verify bank account details
     */
    async resolveBankAccount(
        options: NombaResolveBankAccountOptions
    ): Promise<{ status: boolean; data: NombaResolveBankAccountResponse }> {
        try {
            logger.info(
                {
                    accountNumber: options.account_number,
                    bankCode: options.bank_code,
                },
                "****RESOLVE ACCOUNT REQUEST****** NOMBA"
            );

            const result = await this.nomba.lookupBankAccount({
                accountNumber: options.account_number,
                bankCode: options.bank_code,
            });

            logger.info(
                { result: JSON.stringify(result) },
                "****RESOLVE ACCOUNT RESPONSE****** NOMBA"
            );

            if (!result || result.code !== "00") {
                throw new e.NOMBABankException(
                    result?.description || "Failed to resolve bank account",
                    HttpStatus.BAD_REQUEST
                );
            }

            const data = result.data;
            if (!data || !data.accountNumber || !data.accountName) {
                logger.error(
                    { result: JSON.stringify(result) },
                    "****RESOLVE ACCOUNT INVALID DATA****** NOMBA"
                );
                throw new e.NOMBABankException(
                    "Account not found. Please verify your account number and selected bank.",
                    HttpStatus.BAD_REQUEST
                );
            }

            return {
                status: true,
                data: {
                    accountNumber: data.accountNumber,
                    accountName: data.accountName,
                    bankCode: data.bankCode,
                },
            };
        } catch (error) {
            logger.error(error, "****RESOLVE ACCOUNT****** NOMBA");
            if (error instanceof e.NOMBABankException) {
                throw error;
            }
            throw new e.NOMBABankException(
                error instanceof Error
                    ? error.message
                    : "Failed to resolve bank account",
                HttpStatus.BAD_REQUEST
            );
        }
    }

    /**
     * Create a virtual account for receiving payments
     */
    async createVirtualAccount(
        user: NombaUserRecord,
        options?: Partial<NombaVirtualAccountOptions>
    ) {
        try {
            const accountRef =
                options?.accountRef || `user-${user.id}-${Date.now()}`;
            const accountName =
                options?.accountName ||
                `${user.firstName} ${user.lastName}`.trim() ||
                "Flipxer User";

            logger.info(
                { userId: user.id, accountRef, accountName },
                "****CREATE VIRTUAL ACCOUNT REQUEST****** NOMBA"
            );

            const result = await this.nomba.createVirtualAccount({
                accountRef,
                accountName,
                currency: "NGN",
                expiryDate: options?.expiryDate,
            });

            logger.info(
                { result: JSON.stringify(result) },
                "****CREATE VIRTUAL ACCOUNT RESPONSE****** NOMBA"
            );

            if (!result || result.code !== "00") {
                throw new e.NombaVirtualAccountException(
                    result?.description || "Failed to create virtual account",
                    HttpStatus.BAD_REQUEST
                );
            }

            return {
                status: true,
                data: result.data,
            };
        } catch (error) {
            logger.error(error, "****CREATE VIRTUAL ACCOUNT****** NOMBA");
            if (error instanceof e.NombaVirtualAccountException) {
                throw error;
            }
            throw new e.NombaVirtualAccountException(
                error instanceof Error
                    ? error.message
                    : "Failed to create virtual account",
                HttpStatus.BAD_REQUEST
            );
        }
    }

    /**
     * Initialize payment using Nomba Checkout
     * Returns a checkout link for the user to complete payment
     *
     * NOTE: When integrating redirect-based checkout flows, callers may provide a
     * deterministic reference so the frontend can safely verify status post-redirect.
     */
    async initializePayment(
        user: NombaUserRecord,
        amount: number,
        callbackUrl?: string,
        referenceOverride?: string
    ) {
        try {
            const reference =
                referenceOverride || generateId({ type: "reference" });

            logger.info(
                { userId: user.id, amount, reference },
                "****INITIALIZE PAYMENT REQUEST****** NOMBA"
            );

            const result = await this.nomba.createCheckoutOrder({
                order: {
                    orderReference: reference,
                    customerId: `user-${user.id}`,
                    customerEmail: user.email,
                    amount,
                    currency: "NGN",
                    callbackUrl,
                },
            });

            logger.info(
                { result: JSON.stringify(result) },
                "****INITIALIZE PAYMENT RESPONSE****** NOMBA"
            );

            logger.info(
                {
                    sentReference: reference,
                    returnedReference: result.data?.orderReference,
                },
                "****REFERENCE COMPARISON****** NOMBA"
            );

            if (!result || result.code !== "00") {
                throw new e.NombaWorkflowException(
                    result?.description || "Failed to initialize payment",
                    HttpStatus.BAD_REQUEST
                );
            }

            return {
                status: true,
                message: "Checkout created successfully",
                data: {
                    link: result.data.checkoutLink,
                    // Use Nomba's orderReference as our internal reference
                    // This ensures the redirect URL ref param and webhook orderReference 
                    // match what we store in Payment.reference for verification
                    reference: result.data.orderReference,
                    amount: result.data.amount,
                },
            };
        } catch (error) {
            logger.error(error, "****INITIALIZE PAYMENT****** NOMBA");
            throw new e.NombaWorkflowException(
                error instanceof Error
                    ? error.message
                    : "Failed to initialize payment",
                HttpStatus.BAD_REQUEST
            );
        }
    }

    /**
     * Verify checkout/payment transaction status
     */
    async verifyTransaction(reference: string) {
        try {
            const resp = await this.nomba.getCheckoutStatus(reference);
            if (!resp || !resp.data) {
                throw new e.NombaVerifyTransactionException(
                    "Unable to verify transaction",
                    HttpStatus.NOT_IMPLEMENTED
                );
            }
            return {
                status: true,
                data: resp.data,
            };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.error(error, "****VERIFY TRANSACTION****** NOMBA");

            // If Nomba says "already completed", treat it as success
            // This happens when the webhook already processed the payment
            if (errorMessage.toLowerCase().includes("already completed")) {
                logger.info({ reference }, "Transaction already completed - returning success");
                return {
                    status: true,
                    data: {
                        status: "COMPLETED",
                        orderReference: reference,
                        message: "Transaction already completed",
                    },
                };
            }

            throw new e.NombaVerifyTransactionException(
                errorMessage || "Failed to verify transaction",
                HttpStatus.BAD_REQUEST
            );
        }
    }

    /**
     * Initialize a bank transfer (payout)
     */
    async initializeTransfer(options: NombaInitializeTransferOptions) {
        try {
            // Verify account first
            await this.resolveBankAccount({
                account_number: options.accountNumber,
                bank_code: options.bankCode,
            });

            const transactionId = generateId({ type: "transaction" });
            const totalAmount = options.amount + options.serviceCharge;

            await this.prisma.$transaction(async (tx) => {
                // Create payment record
                await tx.payment.create({
                    data: {
                        amount: options.amount,
                        flow: TransactionFlow.OUT,
                        status: TransactionStatus.PENDING,
                        paymentStatus: TransactionStatus.SUCCESS,
                        totalAmount: totalAmount,
                        type: TransactionType.TRANSFER_FUND,
                        userId: options.userId,
                        transactionId: transactionId,
                        orderId: options.orderId,
                        chargeFee: options.serviceCharge,
                        destinationBankAccountName: options.accountName,
                        destinationBankName: options.bankName,
                        destinationBankAccountNumber: options.accountNumber,
                        reference: options.reference,
                        title: TransactionShortDescription.TRANSFER_FUND,
                        narration: TransactionShortDescription.TRANSFER_FUND,
                        sessionId: generateId({ type: "sessionId" }),
                        shortDescription:
                            TransactionShortDescription.TRANSFER_FUND,
                        paymentMethod: PaymentMethod.NOMBA,
                    },
                });

                // Initiate bank transfer via Nomba
                await this.nomba.initiateBankTransfer({
                    amount: options.amount,
                    accountNumber: options.accountNumber,
                    accountName: options.accountName,
                    bankCode: options.bankCode,
                    merchantTxRef: options.reference,
                    narration: options.narration || "Wallet withdrawal",
                    senderName: options.senderName,
                });
            });
        } catch (error) {
            logger.error(error, "****INITIALIZE TRANSFER****** NOMBA");
            if (error instanceof e.NOMBABankException) {
                throw error;
            }
            if (error instanceof e.NombaWorkflowException) {
                throw error;
            }
            if (error instanceof e.NombaTransferException) {
                throw error;
            }
            throw new e.NombaWorkflowException(
                error instanceof Error
                    ? error.message
                    : "Failed to initialize transfer",
                HttpStatus.NOT_IMPLEMENTED
            );
        }
    }

    /**
     * Verify transfer status by merchant reference
     */
    async verifyTransferStatus(reference: string) {
        try {
            const resp = await this.nomba.getTransferByMerchantRef(reference);
            if (!resp || !resp.data) {
                throw new e.NombaVerifyTransactionException(
                    "Unable to verify transfer status",
                    HttpStatus.NOT_IMPLEMENTED
                );
            }

            switch (resp.data.status?.toUpperCase()) {
                case "SUCCESS":
                case "SUCCESSFUL":
                    return { status: "success" as const, data: resp.data };
                case "FAILED":
                    return { status: "failed" as const, data: resp.data };
                case "PROCESSING":
                case "PENDING":
                    return { status: "pending" as const, data: resp.data };
                default:
                    return { status: "pending" as const, data: resp.data };
            }
        } catch (error) {
            logger.error(error, "****VERIFY TRANSFER****** NOMBA");
            if (error instanceof e.NombaVerifyTransactionException) {
                throw error;
            }
            throw new e.NombaWorkflowException(
                error instanceof Error
                    ? error.message
                    : "Failed to verify transfer",
                HttpStatus.NOT_IMPLEMENTED
            );
        }
    }

    /**
     * Record incoming payment from virtual account
     */
    async recordIncomingPayment(options: {
        userId: number;
        amount: number;
        reference: string;
        orderId?: number;
        currency?: string;
    }) {
        await this.prisma.payment.create({
            data: {
                amount: options.amount,
                flow: TransactionFlow.IN,
                status: TransactionStatus.PENDING,
                paymentStatus: TransactionStatus.PENDING,
                totalAmount: options.amount,
                type: TransactionType.P2P_PAYMENT,
                userId: options.userId,
                transactionId: generateId({ type: "transaction" }),
                orderId: options.orderId,
                reference: options.reference,
                title: "Buy order payment",
                narration: "Buy order payment",
                sessionId: generateId({ type: "sessionId" }),
                shortDescription: "Buy order payment",
                paymentMethod: PaymentMethod.NOMBA,
                expectedCurrency: options.currency || "NGN",
            },
        });
    }
}
