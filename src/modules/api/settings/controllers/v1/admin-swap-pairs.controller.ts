import { Body, Controller, Get, Patch, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags, ApiOperation } from "@nestjs/swagger";
import { AuthGuard, EnabledAccountGuard } from "@/modules/api/auth/guard";
import { RoleGuard } from "@/modules/api/authorize/guards/role.guard";
import { PermissionGuard } from "@/modules/api/authorize/guards/permission.guard";
import { UserTypes, ADMIN_USER_TYPES, Permissions } from "@/modules/api/authorize/decorator";
import { PermissionName } from "@/modules/api/authorize/enums/role";
import { PrismaService } from "@/modules/core/prisma/services";
import { buildResponse } from "@/utils/api-response-util";
import { CreateSwapPairDto, BulkUpdateSwapPairDto } from "../../../trade/dtos/create-swap-pair.dto";
import { SUPPORTED_ASSETS } from "../../../trade/constants";

@ApiTags("Admin Swap Pairs")
@Controller("admin/swap-pairs")
@UseGuards(AuthGuard, RoleGuard, EnabledAccountGuard, PermissionGuard)
@UserTypes(ADMIN_USER_TYPES)
@ApiBearerAuth()
export class AdminSwapPairController {
    // Cast once to access swapPair model (not yet in generated Prisma types)
    private readonly db: any;
    constructor(private readonly prisma: PrismaService) {
        this.db = prisma as any;
    }

    @Permissions([PermissionName.SETTINGS_READ])
    @Get()
    @ApiOperation({ summary: "List all swap pairs" })
    async getSwapPairs() {
        // Fetch all specific pairs
        const pairs = await this.db.swapPair.findMany({
            orderBy: [{ fromCurrency: 'asc' }, { toCurrency: 'asc' }]
        });
        return buildResponse({ message: "Swap pairs retrieved", data: pairs });
    }

    @Permissions([PermissionName.SETTINGS_UPDATE])
    @Post()
    @ApiOperation({ summary: "Create or Update a specific Swap Pair Override" })
    async upsertSwapPair(@Body() dto: CreateSwapPairDto) {
        const { fromCurrency, toCurrency, rate, isActive } = dto;

        const pair = await this.db.swapPair.upsert({
            where: {
                fromCurrency_toCurrency: {
                    fromCurrency,
                    toCurrency
                }
            },
            update: {
                rate,
                isActive: isActive ?? true
            },
            create: {
                fromCurrency,
                toCurrency,
                rate,
                isActive: isActive ?? true
            }
        });

        return buildResponse({ message: "Swap pair updated", data: pair });
    }

    @Permissions([PermissionName.SETTINGS_UPDATE])
    @Post("generate")
    @ApiOperation({ summary: "Generate all possible permutations of Swap Pairs (Inactive by default)" })
    async generateAllPairs() {
        const assets = Array.from(SUPPORTED_ASSETS);
        let count = 0;

        // Transaction is safer
        await this.prisma.$transaction(async (tx: any) => {
            for (const fromC of assets) {
                for (const toC of assets) {
                    if (fromC === toC) continue;

                    // Check if exists
                    const exists = await tx.swapPair.findUnique({
                        where: {
                            fromCurrency_toCurrency: {
                                fromCurrency: fromC,
                                toCurrency: toC
                            }
                        }
                    });

                    if (!exists) {
                        await tx.swapPair.create({
                            data: {
                                fromCurrency: fromC,
                                toCurrency: toC,
                                rate: 0, // 0 = Inactive/Derived logic? No, we said >0 is override.
                                isActive: false // Start inactive so Auto-Pilot handles them
                            }
                        });
                        count++;
                    }
                }
            }
        });

        return buildResponse({ message: `Generated ${count} new swap pair records.`, data: count });
    }

    @Permissions([PermissionName.SETTINGS_UPDATE])
    @Patch("bulk")
    @ApiOperation({ summary: "Bulk Update Swap Pairs (e.g. Activate all USDT pairs)" })
    async bulkUpdate(@Body() dto: BulkUpdateSwapPairDto) {
        const { targetCurrency, isActive, rateMultiplier } = dto;
        const target = targetCurrency.toUpperCase();

        const whereClause: any = {
            OR: [
                { fromCurrency: target },
                { toCurrency: target }
            ]
        };

        // If rateMultiplier is provided, we need to fetch, calculate, and update one by one?
        // Or if simple update (isActive), use updateMany.

        if (rateMultiplier) {
            // Complex update: Rate = Rate * Multiplier
            // Only updates ACTIVE or EXISTING rates? 
            // Logic: Update all matching pairs
            const pairs = await this.db.swapPair.findMany({ where: whereClause });
            let updatedCount = 0;

            await this.prisma.$transaction(async (tx: any) => {
                for (const p of pairs) {
                    if (p.rate > 0) {
                        const newRate = p.rate * rateMultiplier;
                        await tx.swapPair.update({
                            where: { fromCurrency_toCurrency: { fromCurrency: p.fromCurrency, toCurrency: p.toCurrency } },
                            data: { rate: newRate, ...(isActive !== undefined && { isActive }) }
                        });
                        updatedCount++;
                    }
                }
            });
            return buildResponse({ message: `Bulk updated rates for ${updatedCount} pairs related to ${target}.` });

        } else {
            // Simple batch update (e.g. enable/disable)
            const result = await this.db.swapPair.updateMany({
                where: whereClause,
                data: {
                    ...(isActive !== undefined && { isActive })
                }
            });
            return buildResponse({ message: `Bulk updated ${result.count} pairs related to ${target}.`, data: result });
        }
    }
}
