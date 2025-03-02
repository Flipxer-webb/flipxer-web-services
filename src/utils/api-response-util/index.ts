import { ApiResponse } from "./interfaces";
export * from "./interfaces";

export function buildResponse<TData = Record<string, any>>(
    options: Omit<ApiResponse<TData>, "success">
): ApiResponse<TData> {
    return {
        success: true,
        message: options.message,
        data: options.data ?? ({} as any),
    };
}
