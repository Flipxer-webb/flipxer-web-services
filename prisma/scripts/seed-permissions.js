const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Map permission groups - PERMISSIONS should map to ROLES
const groupMap = {
  'users': 'USERS',
  'transactions': 'TRANSACTIONS',
  'settings': 'SETTINGS',
  'analytics': 'ANALYTICS',
  'kyc': 'KYC',
  'notifications': 'NOTIFICATIONS',
  'roles': 'ROLES',
  'permissions': 'ROLES', // PERMISSIONS should go to ROLES group
  'system': 'SYSTEM'
};

const PermissionNames = {
  USERS_CREATE: 'users.create',
  USERS_READ: 'users.read',
  USERS_UPDATE: 'users.update',
  USERS_DELETE: 'users.delete',
  USERS_BLOCK: 'users.block',
  USERS_UNBLOCK: 'users.unblock',
  USERS_EXPORT: 'users.export',
  USERS_BULK_ACTION: 'users.bulk_action',
  TRANSACTIONS_READ: 'transactions.read',
  TRANSACTIONS_UPDATE: 'transactions.update',
  TRANSACTIONS_REFUND: 'transactions.refund',
  TRANSACTIONS_EXPORT: 'transactions.export',
  TRANSACTIONS_MANUAL_APPROVE: 'transactions.manual_approve',
  SETTINGS_READ: 'settings.read',
  SETTINGS_UPDATE: 'settings.update',
  SETTINGS_RATES: 'settings.rates',
  SETTINGS_FEES: 'settings.fees',
  ANALYTICS_READ: 'analytics.read',
  ANALYTICS_EXPORT: 'analytics.export',
  KYC_READ: 'kyc.read',
  KYC_APPROVE: 'kyc.approve',
  KYC_REJECT: 'kyc.reject',
  KYC_ESCALATE: 'kyc.escalate',
  NOTIFICATIONS_READ: 'notifications.read',
  NOTIFICATIONS_CREATE: 'notifications.create',
  NOTIFICATIONS_BROADCAST: 'notifications.broadcast',
  ROLES_READ: 'roles.read',
  ROLES_CREATE: 'roles.create',
  ROLES_UPDATE: 'roles.update',
  ROLES_DELETE: 'roles.delete',
  PERMISSIONS_MANAGE: 'permissions.manage',
  SYSTEM_CONFIG: 'system.config',
  SYSTEM_MAINTENANCE: 'system.maintenance',
  SYSTEM_AUDIT_LOGS: 'system.audit_logs'
};

async function seed() {
  console.log('Starting permissions seeding...');
  
  for (const [key, name] of Object.entries(PermissionNames)) {
    const [groupPrefix] = name.split('.');
    const group = groupMap[groupPrefix] || 'SYSTEM';
    console.log(`Seeding: ${name} -> ${group}`);
    await prisma.permission.upsert({
      where: { name },
      update: {},
      create: {
        name,
        description: key.replaceAll('_', ' ').toLowerCase(),
        group
      }
    });
  }
  
  const count = await prisma.permission.count();
  console.log(`Seeded ${count} permissions successfully!`);
  
  await prisma.$disconnect();
}

(async () => { // NOSONAR - CommonJS script cannot use top-level await without module conversion
  try {
    await seed();
  } catch (e) {
    console.error('Error seeding permissions:', e);
    await prisma.$disconnect();
    process.exit(1);
  }
})();
