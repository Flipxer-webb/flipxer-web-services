export type Optional<T, Key extends keyof T> = Omit<T, Key> & Partial<T>;
export interface TransactionIdOption {
    type:
    | "transaction"
    | "reference"
    | "custom_upper_case"
    | "custom_lower_case"
    | "numeric"
    | "identifier"
    | "sessionId";
    length?: number;
}

export const buildPaginationMeta = (
    pageNumber: number,
    pageSize: number,
    totalCount: number,
    recordCount: number
): PaginationMeta => {
    return {
        perPage: pageSize,
        page: pageNumber,
        pageCount: recordCount,
        totalCount: totalCount,
    };
};

export interface Meta {
    [key: string]: string | number;
}

export type GroupBy<TData> = (key: string, data: TData[]) => any;
