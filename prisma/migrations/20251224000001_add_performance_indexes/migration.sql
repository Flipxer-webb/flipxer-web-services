-- Performance Indexes Migration
-- Add composite indexes for frequently queried columns to improve query performance

-- =====================================================
-- Order Table Indexes (Most Critical - Used in all transaction queries)
-- =====================================================

-- Composite index for user transaction history (userId + createdAt DESC)
-- Used by: getUserTransactionHistory, getRecentTransactionList
CREATE INDEX IF NOT EXISTS "Orders_userId_createdAt_idx" ON "Orders" ("userId", "createdAt" DESC);

-- Composite index for filtering by user and status
-- Used by: filtering transactions by status for a specific user
CREATE INDEX IF NOT EXISTS "Orders_userId_status_idx" ON "Orders" ("userId", "status");

-- Composite index for filtering by user and streamlined status
-- Used by: getUserTransactionHistory with status filter
CREATE INDEX IF NOT EXISTS "Orders_userId_streamlinedStatus_idx" ON "Orders" ("userId", "streamlinedStatus");

-- Composite index for order category queries per user
-- Used by: filtering transactions by type (BUY, SELL, SWAP, etc.)
CREATE INDEX IF NOT EXISTS "Orders_userId_orderCategory_idx" ON "Orders" ("userId", "orderCategory");

-- Index for currency-based searches
-- Used by: filtering by asset/currency
CREATE INDEX IF NOT EXISTS "Orders_currency_idx" ON "Orders" ("currency");
CREATE INDEX IF NOT EXISTS "Orders_fromCurrency_idx" ON "Orders" ("fromCurrency");
CREATE INDEX IF NOT EXISTS "Orders_toCurrency_idx" ON "Orders" ("toCurrency");

-- =====================================================
-- Payment Table Indexes
-- =====================================================

-- Composite index for user payment history
CREATE INDEX IF NOT EXISTS "Payments_userId_createdAt_idx" ON "Payments" ("userId", "createdAt" DESC);

-- Composite index for payment status filtering per user
CREATE INDEX IF NOT EXISTS "Payments_userId_status_idx" ON "Payments" ("userId", "status");

-- =====================================================
-- AssetWallet Table Indexes
-- =====================================================

-- Index for active wallets (commonly filtered)
CREATE INDEX IF NOT EXISTS "AssetWallets_userId_isActive_idx" ON "AssetWallets" ("userId", "isActive");

-- =====================================================
-- User Table Indexes
-- =====================================================

-- Index for email lookups (login, password reset)
-- Note: email already has unique index, but adding for explicit performance
CREATE INDEX IF NOT EXISTS "Users_email_isDeleted_idx" ON "Users" ("email", "isDeleted");

-- Index for phone lookups
CREATE INDEX IF NOT EXISTS "Users_phone_isDeleted_idx" ON "Users" ("phone", "isDeleted");

-- Index for verification status queries (admin dashboard)
CREATE INDEX IF NOT EXISTS "Users_isDocumentVerified_idx" ON "Users" ("isDocumentVerified");
CREATE INDEX IF NOT EXISTS "Users_tier_idx" ON "Users" ("tier");

-- =====================================================
-- BankDetail Table Indexes
-- =====================================================

-- Index for bank account lookups by account number
CREATE INDEX IF NOT EXISTS "BankDetails_accountNumber_idx" ON "BankDetails" ("accountNumber");

-- =====================================================
-- Notification Table Indexes
-- =====================================================

-- Composite index for unread notifications per user
CREATE INDEX IF NOT EXISTS "Notifications_userId_isRead_createdAt_idx" ON "Notifications" ("userId", "isRead", "createdAt" DESC);

-- =====================================================
-- Session Table Indexes
-- =====================================================

-- Composite index for active sessions per user
CREATE INDEX IF NOT EXISTS "Sessions_userId_isActive_lastActiveAt_idx" ON "Sessions" ("userId", "isActive", "lastActiveAt" DESC);

-- =====================================================
-- CryptoWalletAddress Table Indexes
-- =====================================================

-- Index for wallet address lookups
CREATE INDEX IF NOT EXISTS "CryptoWalletAddresses_userId_assetSymbol_idx" ON "CryptoWalletAddresses" ("userId", "assetSymbol");

