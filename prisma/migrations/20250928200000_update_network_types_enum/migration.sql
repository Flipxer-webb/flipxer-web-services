-- Sync NetworkTypes enum with current production values
-- Values already exist in production; this migration ensures new environments get the same enum variants.
ALTER TYPE "NetworkTypes" ADD VALUE 'celo';
ALTER TYPE "NetworkTypes" ADD VALUE 'optimism';
ALTER TYPE "NetworkTypes" ADD VALUE 'ton';
ALTER TYPE "NetworkTypes" ADD VALUE 'arbitrum';
ALTER TYPE "NetworkTypes" ADD VALUE 'base';
