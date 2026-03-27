import { HttpStatus } from "@nestjs/common";
import {
    FincraLib,
    FincraPayInPayload,
    FincraBankListResponse,
} from "@/libs/fincra";
import { PrismaService } from "@/modules/core/prisma/services";
import logger from "moment-logger";
import * as Config from "@/config";
import { generateId } from "@/utils";
import {
    PaymentMethod,
    TransactionFlow,
    TransactionStatus,
    TransactionType,
} from "@prisma/client";
import { TFincra } from "../types";
import {
    FincraInitiationResponseResultType,
    UserRecord,
    ResolveBankAccountOptions,
    ResolveBankAccountResponse,
    InitializeTransferOptions,
} from "../types/fincra";
import * as e from "../errors/fincra.error";
import { TransactionShortDescription } from "@/modules/api/transactions/types";

export class FincraBank implements TFincra.IFincraBank {
    name?: string;
    constructor(
        private fincra: FincraLib,
        private prisma: PrismaService
    ) {}

    async getBanks(): Promise<FincraBankListResponse> {
        try {
            const banks = await this.fincra.getBanks("NG");
            if (!banks || !banks.success) {
                throw new e.FINCRABankException(
                    "Failed to fetch banks",
                    HttpStatus.BAD_REQUEST
                );
            }
            return banks;
        } catch (error) {
            logger.error(error, "****GET BANKS****** FINCRA");
            if (error instanceof e.FINCRABankException) {
                throw error;
            }
            throw new e.FINCRABankException(
                error instanceof Error ? error.message : "Failed to fetch banks",
                HttpStatus.BAD_REQUEST
            );
        }
    }

    async resolveBankAccount(
        options: ResolveBankAccountOptions
    ): Promise<{ status: boolean; data: ResolveBankAccountResponse }> {
        try {
            logger.info(
                { accountNumber: options.account_number, bankCode: options.bank_code },
                "****RESOLVE ACCOUNT REQUEST****** FINCRA"
            );

            const result = await this.fincra.resolveBankAccount({
                accountNumber: options.account_number,
                bankCode: options.bank_code,
                currency: "NGN",
                // type defaults to "nuban" for Nigerian bank accounts
            });

            logger.info(
                { result: JSON.stringify(result) },
                "****RESOLVE ACCOUNT RESPONSE****** FINCRA"
            );

            if (!result || !result.success) {
                throw new e.FINCRABankException(
                    result?.message || "Failed to resolve bank account",
                    HttpStatus.BAD_REQUEST
                );
            }

            // Handle both camelCase and snake_case response formats from Fincra
            const data = result.data as any;
            const accountNumber = data?.accountNumber || data?.account_number;
            const accountName = data?.accountName || data?.account_name;
            const bankCode = data?.bankCode || data?.bank_code;

            // Validate that data and required fields exist
            // Fincra returns success:true but data:null when account is not found
            if (!data || !accountNumber || !accountName) {
                logger.error(
                    { result: JSON.stringify(result) },
                    "****RESOLVE ACCOUNT INVALID DATA****** FINCRA"
                );
                throw new e.FINCRABankException(
                    "Account not found. Please verify your account number and selected bank.",
                    HttpStatus.BAD_REQUEST
                );
            }

            return {
                status: true,
                data: {
                    accountNumber,
                    accountName,
                    bankCode,
                },
            };
        } catch (error) {
            logger.error(error, "****RESOLVE ACCOUNT****** FINCRA");
            if (error instanceof e.FINCRABankException) {
                throw error;
            }
            throw new e.FINCRABankException(
                error instanceof Error ? error.message : "Failed to resolve bank account",
                HttpStatus.BAD_REQUEST
            );
        }
    }

    async initializePayment(user: UserRecord, amount: number) {
        try {
            const payload: FincraPayInPayload = {
                amount,
                currency: "NGN",
                reference: generateId({ type: "reference" }),
                redirectUrl: Config.fincraOptions.redirectUrl,
                feeBearer: "customer",
                paymentMethods: ["card", "bank_transfer"],
                customer: {
                    name: `${user.firstName} ${user.lastName}`.trim(),
                    email: user.email,
                    phoneNumber: user.phoneNumber,
                },
                metadata: {
                    userId: user.id,
                },
            };

            const result = await this.fincra.initializeCheckout(payload);
            if (!result?.status || !result.data?.link) {
                throw new Error("Failed to initialize Fincra payment");
            }

            return {
                ...result,
                data: {
                    ...result.data,
                    reference: payload.reference,
                },
            } as { status: boolean; message: string; data: FincraInitiationResponseResultType };
        } catch (error) {
            logger.error(error);
            throw new Error(
                error instanceof Error
                    ? error.message
                    : "Failed to initialize Fincra payment"
            );
        }
    }

    async verifyTransaction(reference: string) {
        try {
            const resp = await this.fincra.verifyPayment(reference);
            if (!resp || !resp.data) {
                throw new Error("Unable to verify fincra transaction");
            }
            return resp;
        } catch (error) {
            logger.error(error);
            const err = new Error(
                error instanceof Error ? error.message : "Failed to verify transaction"
            );
            (err as any).status = (error as any)?.status || HttpStatus.BAD_REQUEST;
            throw err;
        }
    }

    async recordTransferPlaceholder() {
        // No transfer support via Fincra in this provider yet
    }

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
                paymentMethod: PaymentMethod.FINCRA,
                expectedCurrency: options.currency || "NGN",
            },
        });
    }

    async initializeTransfer(options: InitializeTransferOptions) {
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
                        shortDescription: TransactionShortDescription.TRANSFER_FUND,
                        paymentMethod: PaymentMethod.FINCRA,
                    },
                });

                // Initiate bank transfer via Fincra
                const nameParts = options.accountName.split(" ");
                const firstName = nameParts[0] || "Customer";
                const lastName = nameParts.slice(1).join(" ") || "User";

                await this.fincra.initiateBankTransfer({
                    amount: options.amount,
                    business: Config.fincraOptions.businessId || "",
                    sourceCurrency: "NGN",
                    destinationCurrency: "NGN",
                    description: "Wallet withdrawal",
                    paymentDestination: "bank_account",
                    customerReference: options.reference,
                    beneficiary: {
                        firstName,
                        lastName,
                        accountHolderName: options.accountName,
                        accountNumber: options.accountNumber,
                        bankCode: options.bankCode,
                        type: "individual",
                        country: "NG",
                    },
                    sender: options.senderName
                        ? {
                              name: options.senderName,
                              email: options.senderEmail || "",
                          }
                        : undefined,
                });
            });
        } catch (error) {
            logger.error(error, "****INITIALIZE TRANSFER****** FINCRA");
            if (error instanceof e.FINCRABankException) {
                throw error;
            }
            if (error instanceof e.FincraWorkflowException) {
                throw error;
            }
            if (error instanceof e.FincraTransferException) {
                throw error;
            }
            throw new e.FincraWorkflowException(
                error instanceof Error ? error.message : "Failed to initialize transfer",
                HttpStatus.NOT_IMPLEMENTED
            );
        }
    }

    async verifyTransferStatus(reference: string) {
        try {
            const resp = await this.fincra.verifyPayoutByCustomerReference(reference);
            if (!resp || !resp.data) {
                throw new e.FincraVerifyTransactionException(
                    "Unable to verify transfer status",
                    HttpStatus.NOT_IMPLEMENTED
                );
            }

            switch (resp.data.status.toLowerCase()) {
                case "successful":
                    return { status: "success", data: resp.data };
                case "failed":
                    return { status: "failed", data: resp.data };
                case "processing":
                case "pending":
                    return { status: "pending", data: resp.data };
                default:
                    return { status: "pending", data: resp.data };
            }
        } catch (error) {
            logger.error(error, "****VERIFY TRANSFER****** FINCRA");
            if (error instanceof e.FincraVerifyTransactionException) {
                throw error;
            }
            throw new e.FincraWorkflowException(
                error instanceof Error ? error.message : "Failed to verify transfer",
                HttpStatus.NOT_IMPLEMENTED
            );
        }
    }
}
