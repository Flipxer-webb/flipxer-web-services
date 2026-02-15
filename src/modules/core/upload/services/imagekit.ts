import { BaseUploadService } from "./base";
import { CompressImageOptions, DeleteImageKitFileOptions } from "../interfaces";
import ImageKit from "imagekit";
import { UploadResponse } from "imagekit/dist/libs/interfaces";

export class ImagekitService extends BaseUploadService {
    constructor(private readonly imagekit: ImageKit) {
        super();
    }

    public async uploadImage(
        options: CompressImageOptions
    ): Promise<UploadResponse> {
        const base64String = `data:image/${
            options.format
        };base64,${options.body.toString("base64")}`;

        const uploadedResponse = await this.imagekit.upload({
            file: base64String,
            fileName: options.name,
            folder: options.dir,
        });

        return uploadedResponse;
    }

    public async uploadCompressedImage(
        options: CompressImageOptions
    ): Promise<UploadResponse> {
        let compressedBuffer: Buffer;
        try {
            compressedBuffer = await this.compressImage(options);
        } catch (err) {
            const error = new Error(
                `[ImageKit] Sharp compression failed for "${options.name}": ${err?.message}`
            );
            error.name = "ImageCompressionError";
            (error as any).cause = err;
            throw error;
        }

        try {
            const uploadedResponse = await this.imagekit.upload({
                file: compressedBuffer,
                fileName: options.name,
                folder: options.dir,
            });

            return uploadedResponse;
        } catch (err) {
            const error = new Error(
                `[ImageKit] Upload API failed for "${options.name}": ${err?.message}`
            );
            error.name = "ImageKitUploadError";
            (error as any).cause = err;
            throw error;
        }
    }

    public async removeImage(options: DeleteImageKitFileOptions) {
        await this.imagekit.deleteFile(options.fileId);
        return true;
    }
}
