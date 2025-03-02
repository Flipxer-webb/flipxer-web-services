export type ImageFormat = "webp" | "jpeg" | "png";
export type CloudiImageFormat = "image";

export interface UploadImageOptions {
    dir: string;
    name: string;
    body: Buffer;
    encoding?: string;
    format: ImageFormat;
    type?: CloudiImageFormat;
}

export interface CompressImageOptions extends UploadImageOptions {
    quality?: number;
    width?: number;
    height?: number;
}

export interface DeleteFileOptions {
    key: string;
}

export interface IUploadService {
    uploadImage(options: UploadImageOptions): Promise<string>;
    uploadCompressedImage(options: CompressImageOptions): Promise<string>;
    deleteFile(options: DeleteFileOptions): Promise<boolean>;
}

type Provider = "cloudinary";
export type BuildOptions = {
    provider: Provider;
};
