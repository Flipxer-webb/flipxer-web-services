import sharp from "sharp";
import { CompressImageOptions } from "../interfaces";

export class BaseUploadService {
    async compressImage(options: CompressImageOptions): Promise<Buffer> {
        const quality = { quality: options.quality };
        const resizedBody = sharp(options.body).resize({
            width: options.width,
            height: options.height,
        });

        switch (true) {
            case options.format == "webp": {
                resizedBody.webp(quality);
            }
            case options.format == "jpeg": {
                resizedBody.jpeg(quality);
            }

            default: {
                resizedBody.png(quality);
            }
        }
        return await resizedBody.toBuffer();
    }
}
