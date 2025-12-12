export enum RoleEnum {
    CUSTOMER = "customer",
    BUSINESS = "business",
    SUPER_ADMIN = "super-admin",
}

export enum PermissionName {
    // User permissions
    CREATE_USERS = "users.create",
    READ_USERS = "users.read",
    UPDATE_USERS = "users.update",
    DELETE_USERS = "users.delete",
    
    // Transaction permissions
    TRANSACTIONS_READ = "transactions.read",
    TRANSACTIONS_UPDATE = "transactions.update",
    TRANSACTIONS_REFUND = "transactions.refund",
    TRANSACTIONS_APPROVE = "transactions.approve",
    TRANSACTIONS_EXPORT = "transactions.export",
    
    // Settings permissions
    SETTINGS_READ = "settings.read",
    SETTINGS_UPDATE = "settings.update",
    
    // Analytics permissions
    ANALYTICS_READ = "analytics.read",
    ANALYTICS_EXPORT = "analytics.export",
    
    // KYC permissions
    KYC_READ = "kyc.read",
    KYC_APPROVE = "kyc.approve",
    KYC_REJECT = "kyc.reject",
    KYC_ESCALATE = "kyc.escalate",
    
    // Notification permissions
    NOTIFICATIONS_READ = "notifications.read",
    NOTIFICATIONS_CREATE = "notifications.create",
    NOTIFICATIONS_UPDATE = "notifications.update",
    NOTIFICATIONS_DELETE = "notifications.delete",
    NOTIFICATIONS_BROADCAST = "notifications.broadcast",
    
    // Role permissions
    ROLES_READ = "roles.read",
    ROLES_CREATE = "roles.create",
    ROLES_UPDATE = "roles.update",
    ROLES_DELETE = "roles.delete",
    
    // Permissions management
    PERMISSIONS_READ = "permissions.read",
    PERMISSIONS_MANAGE = "permissions.manage",
    
    // System permissions
    SYSTEM_AUDIT_LOGS = "system.audit_logs",
    SYSTEM_SETTINGS = "system.settings",
}
