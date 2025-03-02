import { BuildOptions } from "../interfaces";
import { cloudinaryConfig } from "@/config";
import { CloudinaryService } from "./cloudinary";

export class UploadFactory {
    build(options: BuildOptions) {
        switch (options.provider) {
            case "cloudinary": {
                const cdnary = {
                    cloud_name: cloudinaryConfig.cloud_name,
                    api_key: cloudinaryConfig.api_key,
                    api_secret: cloudinaryConfig.api_secret,
                };
                return new CloudinaryService(cdnary);
            }

            default:
                break;
        }
    }
}
