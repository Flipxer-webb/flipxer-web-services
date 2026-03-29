import { HEADERS_METADATA } from "@nestjs/common/constants";
import { CsvHeaders } from "../index";

describe("CsvHeaders", () => {
    it("returns a decorator function", () => {
        const decorator = CsvHeaders("report.csv");
        expect(typeof decorator).toBe("function");
    });

    it("applies content headers to the target method", () => {
        class TestController {
            download() {
                return "ok";
            }
        }

        const descriptor = Object.getOwnPropertyDescriptor(TestController.prototype, "download");
        CsvHeaders("report.csv")(TestController.prototype, "download", descriptor!);

        const headers = Reflect.getMetadata(HEADERS_METADATA, TestController.prototype.download) as Array<{
            name: string;
            value: string;
        }>;

        expect(headers).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ name: "Content-Type", value: "text/csv" }),
                expect.objectContaining({
                    name: "Content-Disposition",
                    value: 'attachment; filename="report.csv"',
                }),
            ]),
        );
    });
});