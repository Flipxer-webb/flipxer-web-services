import sharp from "sharp";
import { CompressImageOptions } from "../interfaces";

export class BaseUploadService {
    async compressImage(options: CompressImageOptions): Promise<Buffer> {
        const quality = { quality: options.quality };
        const resizedBody = sharp(options.body).resize({
            width: options.width,
            height: options.height,
        });

        switch (options.format) {
            case "webp":
                resizedBody.webp(quality);
                break;
            case "jpeg":
                resizedBody.jpeg(quality);
                break;
            case "png":
            default:
                resizedBody.png(quality);
                break;
        }

        return await resizedBody.toBuffer();
    }
}
