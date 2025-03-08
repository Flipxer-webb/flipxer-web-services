import { BuildOptions } from "../interfaces";
import { cloudinaryConfig, imagekitConfig } from "@/config";
import { CloudinaryService } from "./cloudinary";
import ImageKit from "imagekit";
import { ImagekitService } from "./imagekit";

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

            case "imagekit": {
                const imagekit = new ImageKit({
                    publicKey: imagekitConfig.public_key,
                    privateKey: imagekitConfig.private_key,
                    urlEndpoint: imagekitConfig.url,
                });
                return new ImagekitService(imagekit);
            }

            default:
                break;
        }
    }
}
