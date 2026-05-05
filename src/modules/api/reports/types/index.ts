export interface ReportFilters {
    startDate?: Date;
    endDate?: Date;
    currency?: string;
    status?: string;
    orderCategory?: string;
    userType?: string;
    country?: string;
}

export interface TransactionReportRow {
    id: number;
    date: string;
    userId: number;
    userEmail: string;
    userName: string;
    orderCategory: string;
    fromCurrency: string;
    toCurrency: string;
    amount: number;
    fee: number;
    total: number;
    status: string;
    paymentMethod: string;
    reference: string;
}

export interface UserReportRow {
    id: number;
    identifier: string;
    email: string;
    firstName: string;
    lastName: string;
    phone: string;
    userType: string;
    tier: number;
    country: string;
    status: string;
    emailVerified: boolean;
    phoneVerified: boolean;
    governmentIdVerified: boolean;
    documentVerified: boolean;
    createdAt: string;
    lastLogin: string;
    loginCount: number;
}

export interface RevenueReportRow {
    date: string;
    orderCategory: string;
    currency: string;
    transactionCount: number;
    totalVolume: number;
    totalFees: number;
    avgTransactionValue: number;
}

export interface TaxReportRow {
    userId: number;
    userEmail: string;
    userName: string;
    userType: string;
    totalTransactions: number;
    totalVolume: number;
    totalFees: number;
    totalBuyVolume: number;
    totalSellVolume: number;
    totalSwapVolume: number;
    period: string;
}

export interface ReportConfig {
    type: 'transactions' | 'users' | 'revenue' | 'tax';
    format: 'csv' | 'json';
    filters: ReportFilters;
    includeHeaders?: boolean;
}

export interface ReportResult {
    filename: string;
    contentType: string;
    data: string;
    rowCount: number;
    generatedAt: Date;
}
