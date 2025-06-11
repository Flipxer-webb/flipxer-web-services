import {
    PaystackError,
    PaystackLib,
    PaystackResponse,
    BankListResponseData,
    PaystackInitializePaymentResponse,
    PaystackMetadata,
    IPaystackInitializePaymentDetail,
    VerifyTransactionResponseData,
    ResolveBankAccountOptions,
    ResolveBankAccountResponse,
} from "@/libs/paystack";
import { TBankFactory } from "../types";
import logger from "moment-logger";
import * as e from "../errors/paystack.error";
import { HttpStatus } from "@nestjs/common";
import * as Config from "../../../../config";
import { InitializeTransferOptions, UserRecord } from "../types/paystack";
import { generateId } from "@/utils";
import { PrismaService } from "@/modules/core/prisma/services";
import {
    PaymentMethod,
    TransactionFlow,
    TransactionStatus,
    TransactionType,
    UserType,
} from "@prisma/client";
import { TransactionShortDescription } from "@/modules/api/transactions/types";

export class PaystackBank implements TBankFactory<"paystack"> {
    name?: string;
    constructor(
        private paystackBank: PaystackLib,
        private prisma: PrismaService
    ) {}

    async getBanks(): Promise<PaystackResponse<BankListResponseData[]>> {
        try {
            const banks = await this.paystackBank.getBanks();
            return banks;
        } catch (error) {
            logger.error(error, "****GET BANKS****** PAYSTACK");
            switch (true) {
                case error instanceof PaystackError: {
                    throw new e.PAYSTACKBankException(
                        error.message,
                        HttpStatus.BAD_REQUEST
                    );
                }

                default: {
                    throw new e.PAYSTACKBankException(
                        error.message,
                        HttpStatus.BAD_REQUEST
                    );
                }
            }
        }
    }

    async resolveBankAccount(
        options: ResolveBankAccountOptions
    ): Promise<PaystackResponse<ResolveBankAccountResponse>> {
        try {
            const bank = await this.paystackBank.resolveBankAccount(options);
            return bank;
        } catch (error) {
            logger.error(error, "****confirm account number****** PAYSTACK");
            switch (true) {
                case error instanceof PaystackError: {
                    throw new e.PAYSTACKBankException(
                        error.message,
                        HttpStatus.BAD_REQUEST
                    );
                }

                default: {
                    throw new e.PAYSTACKBankException(
                        error.message,
                        HttpStatus.BAD_REQUEST
                    );
                }
            }
        }
    }

    async initializePaystackPayment(
        user: UserRecord,
        amount: number
    ): Promise<PaystackResponse<PaystackInitializePaymentResponse>> {
        try {
            const metadata: PaystackMetadata = {
                user_id: user.id,
                cancel_action: Config.paystackOptions.cancel_action,
                custom_fields: [
                    {
                        display_name: "Name",
                        variable_name: "name",
                        value: `${user.firstName} ${user.lastName}`,
                    },
                    {
                        display_name: "Email",
                        variable_name: "email",
                        value: user.email,
                    },
                    {
                        display_name: "Reason",
                        variable_name: "reason",
                        value: "Resolve payment",
                    },
                ],
            };

            const options: IPaystackInitializePaymentDetail = {
                amount: amount * 100,
                email: user.email,
                ...(Config.paystackOptions.callback_url && {
                    callback_url: Config.paystackOptions.callback_url,
                }),
                metadata: metadata,
            };
            const result = await this.paystackBank.initializePaymentTransaction(
                options
            );
            return result;
        } catch (error) {
            logger.error(error);
            switch (true) {
                case error instanceof PaystackError: {
                    throw new e.PAYSTACKBankException(
                        error.message,
                        HttpStatus.BAD_REQUEST
                    );
                }

                default: {
                    throw new e.PAYSTACKBankException(
                        "Failed to initialize payment",
                        HttpStatus.BAD_REQUEST
                    );
                }
            }
        }
    }

    async verifyTransaction(
        reference: string
    ): Promise<VerifyTransactionResponseData> {
        try {
            const resp = await this.paystackBank.verifyTransaction(reference);

            if (!resp || !resp.data) {
                throw new e.PaystackWorkflowException(
                    "Unable to verify paystack transaction",
                    HttpStatus.NOT_IMPLEMENTED
                );
            }

            switch (resp.data.status) {
                case "success": {
                    return { status: "success", data: resp.data };
                }
                case "abandoned": {
                    return { status: "abandoned", data: resp.data };
                }
                case "failed": {
                    return { status: "failed", data: resp.data };
                }

                default: {
                    throw new e.PaystackWorkflowException(
                        "Invalid paystack transaction status",
                        HttpStatus.INTERNAL_SERVER_ERROR
                    );
                }
            }
        } catch (error) {
            switch (true) {
                case error instanceof e.PaystackWorkflowException: {
                    throw error;
                }
                case error instanceof PaystackError: {
                    const clientError = [400, 404];

                    if (clientError.includes(error.status)) {
                        throw new e.PaystackVerifyTransactionException(
                            error.message,
                            error.status
                        );
                    } else {
                        throw new e.PaystackVerifyTransactionException(
                            "operation failed",
                            HttpStatus.NOT_IMPLEMENTED
                        );
                    }
                }

                default: {
                    throw new e.PaystackWorkflowException(
                        "Failed to verify transfer",
                        HttpStatus.NOT_IMPLEMENTED
                    );
                }
            }
        }
    }

    async initializeTransfer(options: InitializeTransferOptions) {
        try {
            //reconfirm account details
            await this.resolveBankAccount({
                account_number: options.accountNumber,
                bank_code: options.bankCode,
            });

            const generateRecipient =
                await this.paystackBank.createTransferRecipient({
                    account_number: options.accountNumber,
                    bank_code: options.bankCode,
                    currency: "NGN",
                    type: "nuban",
                    name: options.accountName,
                });
            if (!generateRecipient || !generateRecipient.status) {
                throw new e.PaystackTransferException(
                    "Failed to generate recipient code.",
                    HttpStatus.INTERNAL_SERVER_ERROR
                );
            }

            //initiate transfer
            const transactionId = generateId({
                type: "transaction",
            });
            const totalAmount = options.amount + options.serviceCharge;

            await this.prisma.$transaction(async (tx) => {
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
                        paymentMethod: PaymentMethod.PAYSTACK,
                    },
                });

                await this.paystackBank.initiateTransfer({
                    amount: options.amount * 100,
                    recipient: generateRecipient.data.recipient_code,
                    source: "balance",
                    reference: options.reference,
                    reason: "Wallet withdrawal",
                });
            });
        } catch (error) {
            logger.error(error);
            switch (true) {
                case error instanceof e.PAYSTACKBankException: {
                    throw error;
                }

                case error instanceof e.PaystackWorkflowException: {
                    throw error;
                }

                case error instanceof e.PaystackTransferException: {
                    throw error;
                }

                case error instanceof PaystackError: {
                    throw new e.PaystackTransferException(
                        "operation failed",
                        HttpStatus.NOT_IMPLEMENTED
                    );
                }

                default: {
                    throw new e.PaystackWorkflowException(
                        "Failed to initialize transfer",
                        HttpStatus.NOT_IMPLEMENTED
                    );
                }
            }
        }
    }
}
