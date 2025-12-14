export interface SystemSettingDto {
    key: string;
    value: any;
    description?: string;
}

export interface MaintenanceModeConfig {
    enabled: boolean;
    message: string;
    estimatedEndTime?: string;
    allowedIps?: string[];
    bypassAdmins: boolean;
}

export interface FeatureFlagConditions {
    // User tier conditions
    tiers?: number[];
    minTier?: number;
    maxTier?: number;
    
    // Country conditions
    countries?: string[];
    excludeCountries?: string[];
    
    // User type conditions
    userTypes?: string[];
    
    // Percentage rollout
    percentageEnabled?: number;
    
    // Date-based conditions
    startDate?: string;
    endDate?: string;
    
    // Custom user IDs (for testing)
    allowedUserIds?: number[];
    excludeUserIds?: number[];
}

export interface FeatureFlagDto {
    key: string;
    name: string;
    description?: string;
    isEnabled: boolean;
    conditions?: FeatureFlagConditions;
}

export interface UpdateFeatureFlagDto {
    name?: string;
    description?: string;
    isEnabled?: boolean;
    conditions?: FeatureFlagConditions;
}

export interface FeatureFlagEvaluationContext {
    userId?: number;
    userTier?: number;
    userCountry?: string;
    userType?: string;
    userEmail?: string;
}

export interface FeatureFlagAuditEntry {
    action: 'CREATED' | 'ENABLED' | 'DISABLED' | 'CONDITIONS_UPDATED' | 'DELETED';
    previousValue?: any;
    newValue?: any;
    changedById: number;
    changedByEmail?: string;
    reason?: string;
}
