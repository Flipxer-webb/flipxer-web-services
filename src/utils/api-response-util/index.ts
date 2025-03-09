import { ApiResponse } from "./interfaces";
export * from "./interfaces";
// utils/api-response-util.ts (or a dedicated file like utils/swagger-response.ts)
import { ApiProperty } from "@nestjs/swagger";

export class SwaggerResponse<TData = Record<string, any>> {
    @ApiProperty({ example: true })
    success: boolean;

    @ApiProperty({ example: 'Request successful' })
    message: string;

    @ApiProperty({ example: {}, required: false }) // Mark `data` as optional
    data?: TData;
}


export function buildResponse<TData = Record<string, any>>(
    options: Partial<ApiResponse<TData>> & { success?: boolean }
): ApiResponse<TData> {
    return {
        success: options.success ?? true,
        message: options.message,
        data: options.data ?? ({} as any),
    };
}