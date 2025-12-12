export enum PermissionGroup {
    USERS = "USERS",
    TRANSACTIONS = "TRANSACTIONS",
    SETTINGS = "SETTINGS",
    ANALYTICS = "ANALYTICS",
    KYC = "KYC",
    NOTIFICATIONS = "NOTIFICATIONS",
    ROLES = "ROLES",
    SYSTEM = "SYSTEM",
}

export enum PermissionAction {
    CREATE = "create",
    READ = "read",
    UPDATE = "update",
    DELETE = "delete",
    APPROVE = "approve",
    REJECT = "reject",
    EXPORT = "export",
    MANAGE = "manage",
}

// Extended permissions for all admin features
export const PermissionNames = {
    // Users
    USERS_CREATE: "users.create",
    USERS_READ: "users.read",
    USERS_UPDATE: "users.update",
    USERS_DELETE: "users.delete",
    USERS_BLOCK: "users.block",
    USERS_UNBLOCK: "users.unblock",
    USERS_EXPORT: "users.export",
    USERS_BULK_ACTION: "users.bulk_action",

    // Transactions
    TRANSACTIONS_READ: "transactions.read",
    TRANSACTIONS_UPDATE: "transactions.update",
    TRANSACTIONS_REFUND: "transactions.refund",
    TRANSACTIONS_EXPORT: "transactions.export",
    TRANSACTIONS_MANUAL_APPROVE: "transactions.manual_approve",

    // Settings
    SETTINGS_READ: "settings.read",
    SETTINGS_UPDATE: "settings.update",
    SETTINGS_RATES: "settings.rates",
    SETTINGS_FEES: "settings.fees",

    // Analytics
    ANALYTICS_READ: "analytics.read",
    ANALYTICS_EXPORT: "analytics.export",

    // KYC
    KYC_READ: "kyc.read",
    KYC_APPROVE: "kyc.approve",
    KYC_REJECT: "kyc.reject",
    KYC_ESCALATE: "kyc.escalate",

    // Notifications
    NOTIFICATIONS_READ: "notifications.read",
    NOTIFICATIONS_CREATE: "notifications.create",
    NOTIFICATIONS_BROADCAST: "notifications.broadcast",

    // Roles & Permissions
    ROLES_READ: "roles.read",
    ROLES_CREATE: "roles.create",
    ROLES_UPDATE: "roles.update",
    ROLES_DELETE: "roles.delete",
    PERMISSIONS_MANAGE: "permissions.manage",

    // System
    SYSTEM_CONFIG: "system.config",
    SYSTEM_MAINTENANCE: "system.maintenance",
    SYSTEM_AUDIT_LOGS: "system.audit_logs",
} as const;

export type PermissionNameType = (typeof PermissionNames)[keyof typeof PermissionNames];

// Predefined role templates
export const RoleTemplates = {
    SUPER_ADMIN: {
        name: "Super Admin",
        slug: "super-admin",
        description: "Full access to all features",
        permissions: Object.values(PermissionNames),
    },
    ADMIN: {
        name: "Admin",
        slug: "admin",
        description: "Standard admin with most capabilities",
        permissions: [
            PermissionNames.USERS_READ,
            PermissionNames.USERS_UPDATE,
            PermissionNames.USERS_BLOCK,
            PermissionNames.USERS_UNBLOCK,
            PermissionNames.TRANSACTIONS_READ,
            PermissionNames.TRANSACTIONS_UPDATE,
            PermissionNames.TRANSACTIONS_EXPORT,
            PermissionNames.SETTINGS_READ,
            PermissionNames.ANALYTICS_READ,
            PermissionNames.KYC_READ,
            PermissionNames.KYC_APPROVE,
            PermissionNames.KYC_REJECT,
            PermissionNames.NOTIFICATIONS_READ,
            PermissionNames.NOTIFICATIONS_CREATE,
        ],
    },
    COMPLIANCE_OFFICER: {
        name: "Compliance Officer",
        slug: "compliance-officer",
        description: "Focus on KYC and compliance",
        permissions: [
            PermissionNames.USERS_READ,
            PermissionNames.KYC_READ,
            PermissionNames.KYC_APPROVE,
            PermissionNames.KYC_REJECT,
            PermissionNames.KYC_ESCALATE,
            PermissionNames.TRANSACTIONS_READ,
            PermissionNames.SYSTEM_AUDIT_LOGS,
        ],
    },
    FINANCE_MANAGER: {
        name: "Finance Manager",
        slug: "finance-manager",
        description: "Manage transactions and financial settings",
        permissions: [
            PermissionNames.TRANSACTIONS_READ,
            PermissionNames.TRANSACTIONS_UPDATE,
            PermissionNames.TRANSACTIONS_REFUND,
            PermissionNames.TRANSACTIONS_EXPORT,
            PermissionNames.SETTINGS_READ,
            PermissionNames.SETTINGS_RATES,
            PermissionNames.SETTINGS_FEES,
            PermissionNames.ANALYTICS_READ,
            PermissionNames.ANALYTICS_EXPORT,
        ],
    },
    SUPPORT_AGENT: {
        name: "Support Agent",
        slug: "support-agent",
        description: "View-only access with limited actions",
        permissions: [
            PermissionNames.USERS_READ,
            PermissionNames.TRANSACTIONS_READ,
            PermissionNames.NOTIFICATIONS_READ,
            PermissionNames.NOTIFICATIONS_CREATE,
        ],
    },
    VIEWER: {
        name: "Viewer",
        slug: "viewer",
        description: "Read-only access to dashboard",
        permissions: [
            PermissionNames.USERS_READ,
            PermissionNames.TRANSACTIONS_READ,
            PermissionNames.ANALYTICS_READ,
        ],
    },
};
