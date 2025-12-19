import { HttpStatus, Logger } from "@nestjs/common";
import * as QD from "@/libs/quidax";
import { QuidaxException } from "../errors";

/**
 * Centralized error handler for Quidax service operations.
 * Reduces cyclomatic complexity by consolidating error handling logic.
 */
export function handleQuidaxError(
    error: unknown,
    defaultMessage: string,
    logger: Logger
): never {
    logger.error(error);

    if (error instanceof QD.QuidaxError) {
        // Preserve the error code from QuidaxValidationError
        const errorCode = (error as QD.QuidaxValidationError).code;
        throw new QuidaxException(
            error.message ?? `${defaultMessage}. Please try again`,
            error.status ?? HttpStatus.BAD_REQUEST,
            errorCode
        );
    }

    if (error instanceof QuidaxException) {
        throw error;
    }

    throw new QuidaxException(defaultMessage, HttpStatus.NOT_IMPLEMENTED);
}

/**
 * Wrapper to execute a Quidax API call with standardized error handling.
 * @param apiCall - The async API call to execute
 * @param errorMessage - The error message to use if the call fails
 * @param logger - Logger instance for error logging
 * @returns The response from the API call
 */
export async function executeQuidaxCall<T>(
    apiCall: () => Promise<T | null | undefined>,
    errorMessage: string,
    logger: Logger
): Promise<T> {
    try {
        const resp = await apiCall();

        if (!resp) {
            throw new QuidaxException(
                `Unable to ${errorMessage.toLowerCase()}`,
                HttpStatus.BAD_REQUEST
            );
        }

        return resp;
    } catch (error) {
        handleQuidaxError(error, `Failed to ${errorMessage.toLowerCase()}`, logger);
    }
}
