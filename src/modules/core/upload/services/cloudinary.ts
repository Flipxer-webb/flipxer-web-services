import { v2 as cloudinary, UploadApiResponse, ConfigOptions } from "cloudinary";
import { BaseUploadService } from "./base";
import { CompressImageOptions, DeleteFileOptions } from "../interfaces";

export class CloudinaryService extends BaseUploadService {
    constructor(private readonly cloudinaryConfig: ConfigOptions) {
        super();
        cloudinary.config({
            cloud_name: this.cloudinaryConfig.cloud_name,
            api_key: this.cloudinaryConfig.api_key,
            api_secret: this.cloudinaryConfig.api_secret,
        });
    }

    public async uploadImage(
        options: CompressImageOptions
    ): Promise<UploadApiResponse> {
        const base64String = `data:image/${
            options.format
        };base64,${options.body.toString("base64")}`;

        const uploadedResponse = await cloudinary.uploader.upload(
            base64String,
            {
                resource_type: options.type,
                folder: options.dir,
                crop: "scale",
                quality: options.quality,
            }
        );

        return uploadedResponse as UploadApiResponse;
    }

    public async uploadCompressedImage(
        options: CompressImageOptions
    ): Promise<UploadApiResponse> {
        const compressedBuffer = await this.compressImage(options);

        const base64String = `data:image/${
            options.format
        };base64,${compressedBuffer.toString("base64")}`;

        const uploadedResponse = await cloudinary.uploader.upload(
            base64String,
            {
                resource_type: options.type,
                folder: options.dir,
                crop: "scale",
                quality: options.quality,
            }
        );

        return uploadedResponse as UploadApiResponse;
    }

    public async removeImage(options: DeleteFileOptions) {
        await cloudinary.uploader.destroy(options.key);
        return true;
    }
}
