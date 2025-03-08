export {};

declare global {
    type PaginationMeta = {
        perPage: number;
        page: number;
        pageCount: number;
        totalCount: number;
    };

    interface ApiResponse<D extends Record<string, any> = Record<string, any>> {
        success: boolean;
        message: string;
        data?: D;
    }

    interface DataWithPagination<TData = Record<string, any>> {
        meta: Partial<PaginationMeta>;
        records: TData[];
    }
}
