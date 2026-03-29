import {
    formatFileSize,
    isImageFile,
    isPdfFile,
    validateDocumentFile,
} from "../file-validator";

describe("file-validator", () => {
    it("rejects missing file", () => {
        expect(validateDocumentFile(undefined as any)).toMatchObject({
            isValid: false,
            error: "No file provided",
        });
    });

    it("rejects invalid mime type", () => {
        const result = validateDocumentFile({
            buffer: Buffer.from("x".repeat(60 * 1024)),
            mimetype: "text/plain",
            originalname: "notes.txt",
        });

        expect(result.isValid).toBe(false);
        expect(result.error).toContain("Invalid file type");
    });

    it("rejects files below minimum size", () => {
        const result = validateDocumentFile({
            buffer: Buffer.from("x".repeat(10)),
            mimetype: "application/pdf",
            originalname: "doc.pdf",
        });

        expect(result).toMatchObject({
            isValid: false,
        });
        expect(result.error).toContain("too small");
    });

    it("rejects files above maximum size", () => {
        const result = validateDocumentFile({
            size: 6 * 1024 * 1024,
            mimetype: "application/pdf",
            originalname: "doc.pdf",
        });

        expect(result).toMatchObject({
            isValid: false,
        });
        expect(result.error).toContain("too large");
    });

    it("rejects extension/mime mismatch", () => {
        const result = validateDocumentFile({
            size: 100 * 1024,
            mimetype: "application/pdf",
            originalname: "picture.png",
        });

        expect(result).toMatchObject({
            isValid: false,
            error: "File extension does not match file content",
        });
    });

    it("accepts valid file with defaults", () => {
        const result = validateDocumentFile({
            buffer: Buffer.from("x".repeat(80 * 1024)),
            mimetype: "image/jpeg",
            originalname: "id.jpg",
        });

        expect(result).toEqual({ isValid: true });
    });

    it("accepts valid file with custom constraints", () => {
        const result = validateDocumentFile(
            {
                size: 1500,
                mimetype: "application/octet-stream",
                originalname: "blob.bin",
            },
            {
                allowedMimeTypes: ["application/octet-stream"],
                minSizeBytes: 1000,
                maxSizeBytes: 2000,
            }
        );

        expect(result).toEqual({ isValid: true });
    });

    it("formats file sizes", () => {
        expect(formatFileSize(100)).toBe("100 B");
        expect(formatFileSize(2048)).toBe("2.0 KB");
        expect(formatFileSize(3 * 1024 * 1024)).toBe("3.0 MB");
    });

    it("identifies image/pdf mime types", () => {
        expect(isImageFile("image/png")).toBe(true);
        expect(isImageFile("application/pdf")).toBe(false);
        expect(isPdfFile("application/pdf")).toBe(true);
        expect(isPdfFile("image/jpeg")).toBe(false);
    });
});
