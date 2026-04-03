import { ImagekitService } from "../imagekit";

describe("ImagekitService", () => {
    let service: ImagekitService;
    let imagekit: {
        upload: jest.Mock;
        deleteFile: jest.Mock;
    };

    beforeEach(() => {
        imagekit = {
            upload: jest.fn(),
            deleteFile: jest.fn().mockResolvedValue(undefined),
        };

        service = new ImagekitService(imagekit as any);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it("uploads raw file body without compression", async () => {
        const response = { fileId: "img_1", url: "https://cdn.example/file" };
        imagekit.upload.mockResolvedValue(response);

        const result = await service.uploadImage({
            body: Buffer.from("abc"),
            name: "sample.pdf",
            dir: "/docs",
        } as any);

        expect(imagekit.upload).toHaveBeenCalledWith({
            file: Buffer.from("abc"),
            fileName: "sample.pdf",
            folder: "/docs",
        });
        expect(result).toEqual(response);
    });

    it("compresses image before uploading", async () => {
        const compressed = Buffer.from("compressed");
        const response = { fileId: "img_2", url: "https://cdn.example/compressed" };

        jest.spyOn(service as any, "compressImage").mockResolvedValue(compressed);
        imagekit.upload.mockResolvedValue(response);

        const result = await service.uploadCompressedImage({
            body: Buffer.from("raw"),
            name: "avatar.png",
            dir: "/avatars",
        } as any);

        expect(imagekit.upload).toHaveBeenCalledWith({
            file: compressed,
            fileName: "avatar.png",
            folder: "/avatars",
        });
        expect(result).toEqual(response);
    });

    it("wraps compression errors with ImageCompressionError", async () => {
        const compressErr = new Error("sharp failed");
        jest.spyOn(service as any, "compressImage").mockRejectedValue(compressErr);

        await expect(
            service.uploadCompressedImage({
                body: Buffer.from("raw"),
                name: "avatar.png",
                dir: "/avatars",
            } as any),
        ).rejects.toMatchObject({
            name: "ImageCompressionError",
            cause: compressErr,
        });
    });

    it("wraps upload api failures with ImageKitUploadError", async () => {
        const apiErr = new Error("rate limited");
        jest.spyOn(service as any, "compressImage").mockResolvedValue(Buffer.from("compressed"));
        imagekit.upload.mockRejectedValue(apiErr);

        await expect(
            service.uploadCompressedImage({
                body: Buffer.from("raw"),
                name: "avatar.png",
                dir: "/avatars",
            } as any),
        ).rejects.toMatchObject({
            name: "ImageKitUploadError",
            cause: apiErr,
        });
    });

    it("stringifies object upload failures without message", async () => {
        const apiErr = { code: 429, detail: "too many requests" };
        jest.spyOn(service as any, "compressImage").mockResolvedValue(Buffer.from("compressed"));
        imagekit.upload.mockRejectedValue(apiErr);

        await expect(
            service.uploadCompressedImage({
                body: Buffer.from("raw"),
                name: "avatar.png",
                dir: "/avatars",
            } as any),
        ).rejects.toThrow('Upload API failed for "avatar.png": {"code":429,"detail":"too many requests"}');
    });

    it("converts primitive upload failures to string", async () => {
        jest.spyOn(service as any, "compressImage").mockResolvedValue(Buffer.from("compressed"));
        imagekit.upload.mockRejectedValue("network down");

        await expect(
            service.uploadCompressedImage({
                body: Buffer.from("raw"),
                name: "avatar.png",
                dir: "/avatars",
            } as any),
        ).rejects.toThrow('Upload API failed for "avatar.png": network down');
    });

    it("deletes image by file id", async () => {
        await expect(service.removeImage({ fileId: "img_3" } as any)).resolves.toBe(true);
        expect(imagekit.deleteFile).toHaveBeenCalledWith("img_3");
    });
});
