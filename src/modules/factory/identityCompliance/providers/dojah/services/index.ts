import * as DJ from "@/libs/dojah";
import { HttpStatus, Logger } from "@nestjs/common";
import * as t from "../types";
import * as e from "../errors";

export class DojahService {
    private readonly logger = new Logger(DojahService.name);
    constructor(private readonly dojah: DJ.DojahLib) {}

    async verifyBvn(options: DJ.VerifyBvnOptions) {
        try {
            const resp = await this.dojah.verifyBvn({
                bvn: options.bvn,
                first_name: options.first_name,
                last_name: options.last_name,
                dob: options.dob,
            });

            if (!resp) {
                throw new e.DojahException(
                    `Unable to initiate bvn verification`,
                    HttpStatus.BAD_REQUEST
                );
            }

            return resp;
        } catch (error) {
            this.logger.error(error);
            switch (true) {
                case error instanceof DJ.DojahError: {
                    throw new e.DojahException(
                        error.message ??
                            "Failed to initiate bvn verification. Please try again",
                        error.status ?? HttpStatus.BAD_REQUEST
                    );
                }
                case error instanceof e.DojahException: {
                    throw error;
                }

                default: {
                    throw new e.DojahException(
                        "Failed to initiate verification",
                        HttpStatus.NOT_IMPLEMENTED
                    );
                }
            }
        }
    }

    async verifyNin(options: DJ.VerifyNinOptions) {
        try {
            const resp = await this.dojah.verifyNin({
                nin: options.nin,
                first_name: options.first_name,
                last_name: options.last_name,
                dob: options.dob,
            });

            if (!resp) {
                throw new e.DojahException(
                    `Unable to initiate NIN verification`,
                    HttpStatus.BAD_REQUEST
                );
            }

            return resp;
        } catch (error) {
            this.logger.error(error);
            switch (true) {
                case error instanceof DJ.DojahError: {
                    throw new e.DojahException(
                        error.message ??
                            "Failed to initiate NIN verification. Please try again",
                        error.status ?? HttpStatus.BAD_REQUEST
                    );
                }
                case error instanceof e.DojahException: {
                    throw error;
                }

                default: {
                    throw new e.DojahException(
                        "Failed to initiate verification",
                        HttpStatus.NOT_IMPLEMENTED
                    );
                }
            }
        }
    }
}
