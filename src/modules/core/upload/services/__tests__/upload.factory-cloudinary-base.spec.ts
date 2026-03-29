jest.mock("sharp", () => jest.fn());

jest.mock("cloudinary", () => ({
    v2: {
        config: jest.fn(),
        uploader: {
            upload: jest.fn(),
            destroy: jest.fn(),
        },
    },
    __esModule: true,
}));

jest.mock("imagekit", () => jest.fn());

jest.mock("@/config", () => ({
    cloudinaryConfig: {
        cloud_name: "cloud-name",
        api_key: "api-key",
        api_secret: "api-secret",
    },
    imagekitConfig: {
        public_key: "public-key",
        private_key: "private-key",
        url: "https://ik.example.com",
    },
}));

import sharp from "sharp";
import { v2 as cloudinary } from "cloudinary";
import ImageKit from "imagekit";
import { imagekitConfig } from "@/config";
import { BaseUploadService } from "../base";
import { CloudinaryService } from "../cloudinary";
import { UploadFactory } from "../index";
import { ImagekitService } from "../imagekit";

describe("Upload Services", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe("BaseUploadService.compressImage", () => {
        const makeSharpChain = (output: Buffer) => {
            const chain = {
                resize: jest.fn().mockReturnThis(),
                webp: jest.fn().mockReturnThis(),
                jpeg: jest.fn().mockReturnThis(),
                png: jest.fn().mockReturnThis(),
                toBuffer: jest.fn().mockResolvedValue(output),
            };
            (sharp as unknown as jest.Mock).mockReturnValue(chain);
            return chain;
        };

        it("uses webp encoder when format is webp", async () => {
            const service = new BaseUploadService();
            const chain = makeSharpChain(Buffer.from("webp"));

            const result = await service.compressImage({
                body: Buffer.from("image"),
                format: "webp",
                quality: 75,
                width: 200,
                height: 100,
                dir: "avatars",
                name: "avatar.webp",
            });

            expect(chain.resize).toHaveBeenCalledWith({ width: 200, height: 100 });
            expect(chain.webp).toHaveBeenCalledWith({ quality: 75 });
            expect(chain.jpeg).not.toHaveBeenCalled();
            expect(chain.png).not.toHaveBeenCalled();
            expect(result).toEqual(Buffer.from("webp"));
        });

        it("uses jpeg encoder when format is jpeg", async () => {
            const service = new BaseUploadService();
            const chain = makeSharpChain(Buffer.from("jpeg"));

            await service.compressImage({
                body: Buffer.from("image"),
                format: "jpeg",
                quality: 80,
                width: 300,
                height: 300,
                dir: "avatars",
                name: "avatar.jpg",
            });

            expect(chain.jpeg).toHaveBeenCalledWith({ quality: 80 });
            expect(chain.webp).not.toHaveBeenCalled();
            expect(chain.png).not.toHaveBeenCalled();
        });

        it("falls back to png encoder for png format", async () => {
            const service = new BaseUploadService();
            const chain = makeSharpChain(Buffer.from("png"));

            await service.compressImage({
                body: Buffer.from("image"),
                format: "png",
                quality: 85,
                width: 300,
                height: 300,
                dir: "avatars",
                name: "avatar.png",
            });

            expect(chain.png).toHaveBeenCalledWith({ quality: 85 });
            expect(chain.webp).not.toHaveBeenCalled();
            expect(chain.jpeg).not.toHaveBeenCalled();
        });
    });

    describe("CloudinaryService", () => {
        it("configures cloudinary on construction", () => {
            const service = new CloudinaryService({
                cloud_name: "my-cloud",
                api_key: "key",
                api_secret: "secret",
            });

            expect(service).toBeInstanceOf(CloudinaryService);
            expect(cloudinary.config).toHaveBeenCalledWith({
                cloud_name: "my-cloud",
                api_key: "key",
                api_secret: "secret",
            });
        });

        it("uploads raw image buffer", async () => {
            const service = new CloudinaryService({
                cloud_name: "my-cloud",
                api_key: "key",
                api_secret: "secret",
            });
            (cloudinary.uploader.upload as jest.Mock).mockResolvedValue({ public_id: "pid-1" });

            const result = await service.uploadImage({
                body: Buffer.from("raw-image"),
                format: "png",
                quality: 90,
                type: "image",
                dir: "users",
                name: "avatar.png",
            });

            expect(cloudinary.uploader.upload).toHaveBeenCalledWith(
                expect.stringContaining("data:image/png;base64,"),
                expect.objectContaining({
                    resource_type: "image",
                    folder: "users",
                    crop: "scale",
                    quality: 90,
                })
            );
            expect(result).toEqual({ public_id: "pid-1" });
        });

        it("uploads compressed image buffer", async () => {
            const service = new CloudinaryService({
                cloud_name: "my-cloud",
                api_key: "key",
                api_secret: "secret",
            });
            jest.spyOn(service, "compressImage").mockResolvedValue(Buffer.from("compressed"));
            (cloudinary.uploader.upload as jest.Mock).mockResolvedValue({ public_id: "pid-2" });

            const result = await service.uploadCompressedImage({
                body: Buffer.from("raw-image"),
                format: "jpeg",
                quality: 70,
                type: "image",
                dir: "users",
                name: "avatar.jpeg",
            });

            expect(cloudinary.uploader.upload).toHaveBeenCalledWith(
                expect.stringContaining("data:image/jpeg;base64,"),
                expect.objectContaining({ folder: "users" })
            );
            expect(result).toEqual({ public_id: "pid-2" });
        });

        it("destroys image by key", async () => {
            const service = new CloudinaryService({
                cloud_name: "my-cloud",
                api_key: "key",
                api_secret: "secret",
            });
            (cloudinary.uploader.destroy as jest.Mock).mockResolvedValue({ result: "ok" });

            const result = await service.removeImage({ key: "users/pid-2" });

            expect(cloudinary.uploader.destroy).toHaveBeenCalledWith("users/pid-2");
            expect(result).toBe(true);
        });
    });

    describe("UploadFactory", () => {
        it("builds a cloudinary upload service", () => {
            const factory = new UploadFactory();

            const built = factory.build({ provider: "cloudinary" });

            expect(built).toBeInstanceOf(CloudinaryService);
        });

        it("builds an imagekit upload service when credentials exist", () => {
            const factory = new UploadFactory();

            const built = factory.build({ provider: "imagekit" });

            expect(ImageKit).toHaveBeenCalledWith({
                publicKey: "public-key",
                privateKey: "private-key",
                urlEndpoint: "https://ik.example.com",
            });
            expect(built).toBeInstanceOf(ImagekitService);
        });

        it("throws when imagekit credentials are missing", () => {
            const factory = new UploadFactory();
            imagekitConfig.public_key = "";

            expect(() => factory.build({ provider: "imagekit" })).toThrow(
                "[UploadFactory] ImageKit credentials missing"
            );
        });
    });
});