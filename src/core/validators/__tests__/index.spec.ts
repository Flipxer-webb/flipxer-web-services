import * as validatorExports from "../index";
import * as directExports from "../file-validator";

describe("validators barrel exports", () => {
    it("re-exports file validator helpers", () => {
        expect(validatorExports.validateDocumentFile).toBe(directExports.validateDocumentFile);
        expect(validatorExports.formatFileSize).toBe(directExports.formatFileSize);
        expect(validatorExports.isImageFile).toBe(directExports.isImageFile);
        expect(validatorExports.isPdfFile).toBe(directExports.isPdfFile);
    });
});
