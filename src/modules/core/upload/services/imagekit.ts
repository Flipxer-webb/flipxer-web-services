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
        const compressedBuffer = await this.compressImage(options);

        const base64String = `data:image/${
            options.format
        };base64,${compressedBuffer.toString("base64")}`;

        const uploadedResponse = await this.imagekit.upload({
            file: compressedBuffer, //base64String,
            fileName: options.name,
            folder: options.dir,
        });

        return uploadedResponse;
    }

    public async removeImage(options: DeleteImageKitFileOptions) {
        await this.imagekit.deleteFile(options.fileId);
        return true;
    }
}
