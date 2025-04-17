import { Inject, Injectable, Logger } from "@nestjs/common";
import { ApiResponse, buildResponse } from "@/utils/api-response-util";
import { PrismaService } from "@/modules/core/prisma/services";

import { TradingInjectionToken } from "@/modules/factory/trading/types";
import { QuidaxService } from "@/modules/factory/trading/providers/quidax/services";

@Injectable()
export class TradingService {
    private readonly logger = new Logger("TradeService");
    constructor(
        private prisma: PrismaService,
        @Inject(TradingInjectionToken.QUIDAX)
        private readonly quidaxService: QuidaxService
    ) {}
}
