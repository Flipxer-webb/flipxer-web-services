import * as QD from "@/libs/quidax";
import { HttpStatus, Logger } from "@nestjs/common";
import * as t from "../types";
import * as e from "../errors";

export class QuidaxService {
    private readonly logger = new Logger(QuidaxService.name);
    constructor(private readonly quidax: QD.QuidaxLib) {}

    async instantOrdersRequery(
        options: t.InstantOrdersRequeryOptions
    ): Promise<QD.QuidaxResponse<QD.InstantOrderResponse>> {
        try {
            const resp = await this.quidax.instantOrdersRequery(options);

            if (!resp) {
                throw new e.QuidaxException(
                    `Unable to retrieve order record`,
                    HttpStatus.BAD_REQUEST
                );
            }

            return resp;
        } catch (error) {
            this.logger.error(error);
            switch (true) {
                case error instanceof QD.QuidaxError: {
                    throw new e.QuidaxException(
                        error.message ??
                            "Failed to retrieve order record. Please try again",
                        error.status ?? HttpStatus.BAD_REQUEST
                    );
                }
                case error instanceof e.QuidaxException: {
                    throw error;
                }

                default: {
                    throw new e.QuidaxException(
                        "Failed to retrieve order record",
                        HttpStatus.NOT_IMPLEMENTED
                    );
                }
            }
        }
    }
}
