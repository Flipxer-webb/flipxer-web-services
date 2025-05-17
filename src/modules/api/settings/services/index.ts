import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import { buildResponse } from "@/utils/api-response-util";
import { PrismaService } from "@/modules/core/prisma/services";

@Injectable()
export class SettingService {
    private readonly logger = new Logger("SettingService");
    constructor(private prisma: PrismaService) {}

    getSupportedNetworks() {
        return buildResponse({
            message: "Supported networks retrieved",
            data: {},
        });
    }
}
