export interface ApiResponse<D = Record<string, any>> {
    success: boolean;
    message: string;
    data?: D;
}
export interface DataWithPagination<TData = Record<string, any>> {
    meta: Partial<PaginationMeta>;
    records: TData[];
}
