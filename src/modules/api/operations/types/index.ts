export interface WalletBalance {
    currency: string;
    name: string;
    balance: string;
    availableBalance: string;
    lockedBalance: string;
    usdValue?: number;
    ngnValue?: number;
    threshold?: number;
    belowThreshold?: boolean;
    network?: string;
    isCrypto?: boolean;
}

export interface AggregatedWalletBalance {
    totalUsdValue: number;
    totalNgnValue: number;
    wallets: WalletBalance[];
    lastUpdated: string;
}

export interface LiquidityThreshold {
    currency: string;
    minBalance: number;
    maxBalance: number;
    alertEnabled: boolean;
}

export interface SlackMessage {
    text: string;
    blocks?: SlackBlock[];
    attachments?: SlackAttachment[];
}

export interface SlackBlock {
    type: string;
    text?: {
        type: string;
        text: string;
        emoji?: boolean;
    };
    elements?: any[];
    accessory?: any;
}

export interface SlackAttachment {
    color?: string;
    blocks?: SlackBlock[];
    text?: string;
    title?: string;
    fields?: { title: string; value: string; short?: boolean }[];
}

export interface AlertCooldownCheck {
    canAlert: boolean;
    lastAlertedAt?: Date;
    cooldownRemainingMinutes?: number;
}

export interface CreateSlackWebhookDto {
    name: string;
    webhookUrl: string;
    channel?: string;
    alertTypes: string[];
    isActive?: boolean;
}

export interface UpdateSlackWebhookDto {
    name?: string;
    webhookUrl?: string;
    channel?: string;
    alertTypes?: string[];
    isActive?: boolean;
}

export interface CreateLiquidityAlertDto {
    currency: string;
    alertType: 'LOW_BALANCE' | 'HIGH_BALANCE' | 'UNUSUAL_ACTIVITY' | 'RATE_DEVIATION';
    threshold: number;
    currentValue?: number;
}

export interface ResolveLiquidityAlertDto {
    note?: string;
}

export interface LiquidityAlertFilters {
    status?: 'PENDING' | 'ACKNOWLEDGED' | 'RESOLVED' | 'ESCALATED';
    currency?: string;
    alertType?: string;
    startDate?: Date;
    endDate?: Date;
    page?: number;
    limit?: number;
}
