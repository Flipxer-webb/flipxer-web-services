import { applyDecorators, Header } from "@nestjs/common";

export function CsvHeaders(filename: string) {
    return applyDecorators(
        Header("Content-Type", "text/csv"),
        Header("Content-Disposition", `attachment; filename="${filename}"`)
    );
}
