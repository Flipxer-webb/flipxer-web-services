/**
 * File validation utilities for document uploads
 * Validates file type, size, and basic integrity
 */

export interface FileValidationResult {
    isValid: boolean;
    error?: string;
}

export interface FileValidationOptions {
    allowedMimeTypes?: string[];
    minSizeBytes?: number;
    maxSizeBytes?: number;
}

// Default allowed MIME types for document uploads
const DEFAULT_ALLOWED_MIME_TYPES = [
    "application/pdf",
    "image/jpeg",
    "image/jpg",
    "image/png",
];

// Default size limits
const DEFAULT_MIN_SIZE_BYTES = 50 * 1024; // 50KB
const DEFAULT_MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5MB

/**
 * Validate a document file for upload
 * @param file - The file object with buffer, mimetype, and size
 * @param options - Optional validation configuration
 * @returns FileValidationResult with isValid flag and optional error message
 */
export function validateDocumentFile(
    file: {
        buffer?: Buffer;
        mimetype?: string;
        size?: number;
        originalname?: string;
    },
    options: FileValidationOptions = {}
): FileValidationResult {
    const allowedMimeTypes = options.allowedMimeTypes || DEFAULT_ALLOWED_MIME_TYPES;
    const minSizeBytes = options.minSizeBytes ?? DEFAULT_MIN_SIZE_BYTES;
    const maxSizeBytes = options.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES;

    // Check if file exists
    if (!file || (!file.buffer && !file.size)) {
        return {
            isValid: false,
            error: "No file provided",
        };
    }

    // Get file size from buffer or size property
    const fileSize = file.buffer?.length || file.size || 0;

    // Validate file type
    if (!file.mimetype || !allowedMimeTypes.includes(file.mimetype.toLowerCase())) {
        return {
            isValid: false,
            error: `Invalid file type. Allowed types: PDF, JPEG, PNG`,
        };
    }

    // Validate minimum size (to prevent empty/placeholder files)
    if (fileSize < minSizeBytes) {
        const minSizeKB = Math.round(minSizeBytes / 1024);
        return {
            isValid: false,
            error: `File is too small. Minimum size: ${minSizeKB}KB`,
        };
    }

    // Validate maximum size
    if (fileSize > maxSizeBytes) {
        const maxSizeMB = Math.round(maxSizeBytes / (1024 * 1024));
        return {
            isValid: false,
            error: `File is too large. Maximum size: ${maxSizeMB}MB`,
        };
    }

    // Additional validation: check file extension matches MIME type
    if (file.originalname) {
        const ext = file.originalname.toLowerCase().split(".").pop();
        const mimeType = file.mimetype.toLowerCase();
        
        const validCombinations: Record<string, string[]> = {
            pdf: ["application/pdf"],
            jpg: ["image/jpeg", "image/jpg"],
            jpeg: ["image/jpeg", "image/jpg"],
            png: ["image/png"],
        };

        if (ext && validCombinations[ext] && !validCombinations[ext].includes(mimeType)) {
            return {
                isValid: false,
                error: "File extension does not match file content",
            };
        }
    }

    return { isValid: true };
}

/**
 * Get human-readable file size
 * @param bytes - File size in bytes
 * @returns Formatted string like "1.5 MB"
 */
export function formatFileSize(bytes: number): string {
    if (bytes < 1024) {
        return `${bytes} B`;
    } else if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(1)} KB`;
    } else {
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }
}

/**
 * Check if a file is an image
 * @param mimetype - The MIME type of the file
 * @returns true if the file is an image
 */
export function isImageFile(mimetype: string): boolean {
    return mimetype.startsWith("image/");
}

/**
 * Check if a file is a PDF
 * @param mimetype - The MIME type of the file
 * @returns true if the file is a PDF
 */
export function isPdfFile(mimetype: string): boolean {
    return mimetype === "application/pdf";
}
