/*
  Warnings:

  - The values [base1] on the enum `NetworkTypes` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "NetworkTypes_new" AS ENUM ('trc20', 'erc20', 'bep20', 'btc', 'ltc', 'dash', 'doge', 'bch', 'ripple', 'stellar', 'cardano', 'solana', 'polygon', 'celo', 'optimism', 'ton', 'arbitrum', 'base');
ALTER TABLE "CryptoWalletAddresses" ALTER COLUMN "network" TYPE "NetworkTypes_new" USING ("network"::text::"NetworkTypes_new");
ALTER TYPE "NetworkTypes" RENAME TO "NetworkTypes_old";
ALTER TYPE "NetworkTypes_new" RENAME TO "NetworkTypes";
DROP TYPE "NetworkTypes_old";
COMMIT;
