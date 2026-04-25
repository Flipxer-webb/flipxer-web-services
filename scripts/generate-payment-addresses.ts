import "dotenv/config";
import "tsconfig-paths/register";

import { NestFactory } from "@nestjs/core";
import { AppModule } from "@/modules";
import { PrismaService } from "@/modules/core/prisma/services";
import { TradingService } from "@/modules/api/trade/services";

// Supported cryptocurrencies with full Quidax wallet support
const SUPPORTED_ASSETS = [
    "BTC",   // Bitcoin
    "ETH",   // Ethereum
    "USDT",  // Tether
    "USDC",  // USD Coin
    "BNB",   // Binance Coin
    "SOL",   // Solana
    "XRP",   // Ripple
    "ADA",   // Cardano
    "DOGE",  // Dogecoin
    "LTC",   // Litecoin
    "TRX",   // Tron
    "SHIB",  // Shiba Inu
] as const;
type SupportedAsset = typeof SUPPORTED_ASSETS[number];

interface CliOptions {
    userId?: number;
    asset?: SupportedAsset;
    limit?: number;
    dryRun?: boolean;
}

interface WalletCombination {
    userId: number;
    assetSymbol: SupportedAsset;
    cryptoSubAccountId: string;
}

function parseCliOptions(): CliOptions {
    const options: CliOptions = {};

    for (const arg of process.argv.slice(2)) {
        if (!arg.startsWith("--")) {
            continue;
        }

        const [rawKey, rawValue] = arg.slice(2).split("=");
        const key = rawKey.trim();
        const value = rawValue?.trim();

        switch (key) {
            case "userId": {
                const parsed = Number(value);
                if (!Number.isNaN(parsed)) {
                    options.userId = parsed;
                }
                break;
            }
            case "asset": {
                if (value) {
                    const parsed = value.toUpperCase();
                    if (
                        (SUPPORTED_ASSETS as unknown as string[]).includes(parsed)
                    ) {
                        options.asset = parsed as SupportedAsset;
                    } else {
                        console.warn(
                            `Ignoring unsupported asset '${value}'. Supported assets: ${SUPPORTED_ASSETS.join(
                                ", "
                            )}`
                        );
                    }
                }
                break;
            }
            case "limit": {
                const parsed = Number(value);
                if (!Number.isNaN(parsed)) {
                    options.limit = parsed;
                }
                break;
            }
            case "dryRun": {
                options.dryRun = value ? value === "true" : true;
                break;
            }
            default:
                break;
        }
    }

    return options;
}

async function main() {
    const options = parseCliOptions();
    const app = await NestFactory.createApplicationContext(AppModule, {
        logger: false,
    });

    const prisma = app.get(PrismaService);
    const tradingService = app.get(TradingService);

    const supportedAssetSet = new Set<string>(SUPPORTED_ASSETS);

    if (options.asset && !supportedAssetSet.has(options.asset)) {
        console.error(
            `Unsupported asset ${options.asset}. Supported assets: ${SUPPORTED_ASSETS.join(
                ", "
            )}`
        );
        await prisma.$disconnect();
        await app.close();
        process.exit(1);
    }

    const users = await prisma.user.findMany({
        where: {
            cryptoSubAccountId: { not: null },
            ...(options.userId && { id: options.userId }),
        },
        select: {
            id: true,
            cryptoSubAccountId: true,
        },
        orderBy: { id: "asc" },
    });

    if (!users.length) {
        console.log("No users with crypto sub-accounts matched the provided filters.");
        await prisma.$disconnect();
        await app.close();
        return;
    }

    const assetsToProcess: SupportedAsset[] = options.asset
        ? ([options.asset] as SupportedAsset[])
        : SUPPORTED_ASSETS.slice();

    const combinations: WalletCombination[] = [];

    for (const user of users) {
        if (!user.cryptoSubAccountId) {
            continue;
        }

        for (const asset of assetsToProcess) {
            combinations.push({
                userId: user.id,
                assetSymbol: asset,
                cryptoSubAccountId: user.cryptoSubAccountId,
            });
        }
    }

    console.log("combinations", { combinations });

    if (!combinations.length) {
        console.log("No wallet combinations found that match the provided filters.");
        await prisma.$disconnect();
        await app.close();
        return;
    }

    const limitedCombinations = options.limit
        ? combinations.slice(0, options.limit)
        : combinations;

    console.log(
        `Processing ${limitedCombinations.length} wallet combination(s)` +
            (options.dryRun ? " [dry-run]" : "")
    );

    let processed = 0;
    let createdCount = 0;

    for (const combo of limitedCombinations) {
        processed += 1;
        const contextLabel = `user=${combo.userId} asset=${combo.assetSymbol}`;

        if (!combo.cryptoSubAccountId) {
            console.warn(`[SKIP] ${contextLabel} -> missing crypto sub-account`);
            continue;
        }

        if (options.dryRun) {
            console.log(`[DRY-RUN] ${contextLabel}`);
            console.log("comb", { combo });
            continue;
        }

        try {
            const created = await tradingService.ensureWalletPaymentAddresses({
                userId: combo.userId,
                cryptoSubAccountId: combo.cryptoSubAccountId,
                assetSymbol: combo.assetSymbol,
            });

            console.log("created", { created });

            if (created.length) {
                createdCount += created.length;
                console.log(
                    `[OK] ${contextLabel} -> created ${created.length} wallet address(es)`
                );
            } else {
                console.log(`[OK] ${contextLabel} -> all networks already exist`);
            }
        } catch (error: any) {
            const message = error?.message ?? error;
            console.error(`[ERROR] ${contextLabel} -> ${message}`);
        }
    }

    console.log(
        `Finished processing ${processed} wallet group(s). Created ${createdCount} new crypto wallet address record(s).`
    );

    await prisma.$disconnect();
    await app.close();
}

main().catch((error) => {
    console.error("Failed to complete wallet address generation", error);
    process.exit(1);
});
