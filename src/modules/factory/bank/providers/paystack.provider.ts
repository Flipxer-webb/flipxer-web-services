import {
    PaystackError,
    PaystackLib,
    PaystackResponse,
    BankListResponseData,
    PaystackInitializePaymentResponse,
    PaystackMetadata,
    IPaystackInitializePaymentDetail,
    VerifyTransactionResponseData,
} from "@/libs/paystack";
import { TBankFactory } from "../types";
import logger from "moment-logger";
import * as e from "../errors/paystack.error";
import { HttpStatus } from "@nestjs/common";
import * as Config from "../../../../config";
import { UserRecord } from "../types/paystack";

export class PaystackBank implements TBankFactory<"paystack"> {
    name?: string;
    constructor(private paystackBank: PaystackLib) {}

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
                        value: "Resolve Payout payment",
                    },
                ],
            };

            const options: IPaystackInitializePaymentDetail = {
                amount: amount * 100,
                email: user.email,
                // ...(Config.paystackOptions.callback_url && {
                //     callback_url: Config.paystackOptions.callback_url,
                // }),
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
}
