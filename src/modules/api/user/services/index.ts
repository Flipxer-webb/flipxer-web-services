import { storageDirConfig } from "@/config";
import { EmailService } from "@/modules/core/email/services";
import { PrismaService } from "@/modules/core/prisma/services";
import { generateRandomNum } from "@/utils";
import { ApiResponse, buildResponse } from "@/utils/api-response-util";
import { forwardRef, Inject, Injectable } from "@nestjs/common";

import { AuthService } from "../../auth/services";

import { UploadFactory } from "@/modules/core/upload/services";
import { CloudinaryService } from "@/modules/core/upload/services/cloudinary";
import { UploadApiResponse } from "cloudinary";
import { User } from "@prisma/client";

@Injectable()
export class UserService {
    private uploadService: CloudinaryService;
    constructor(
        private prisma: PrismaService,
        @Inject(forwardRef(() => AuthService))
        private authService: AuthService,
        private emailService: EmailService,
        private uploadFactory: UploadFactory
    ) {
        this.uploadService = this.uploadFactory.build({
            provider: "cloudinary",
        });
    }

    async getProfile(): Promise<ApiResponse> {
        const profile = {};
        return buildResponse({
            message: "Profile successfully retrieved",
            data: profile,
        });
    }

    private async uploadProfileImage(file: string): Promise<UploadApiResponse> {
        const date = Date.now();
        const body = Buffer.from(file, "base64");

        return await this.uploadService.uploadCompressedImage({
            dir: storageDirConfig.profile,
            name: `profile-image-${date}-${generateRandomNum(5)}`,
            format: "webp",
            body: body,
            quality: 100,
            width: 320,
            type: "image",
        });
    }
}
