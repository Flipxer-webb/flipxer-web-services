import { HttpException } from "@nestjs/common";

export type DojahExceptionMetadata = {
    responseBody?: unknown;
    requestMetadata?: Record<string, unknown> | null;
    providerErrorName?: string;
};

export class DojahException extends HttpException {
    name = "DojahException";

    readonly responseBody?: unknown;
    readonly requestMetadata?: Record<string, unknown> | null;
    readonly providerErrorName?: string;

    constructor(
        response: string | Record<string, unknown>,
        status: number,
        metadata: DojahExceptionMetadata = {},
    ) {
        super(response, status);
        this.responseBody = metadata.responseBody;
        this.requestMetadata = metadata.requestMetadata;
        this.providerErrorName = metadata.providerErrorName;
    }
}
