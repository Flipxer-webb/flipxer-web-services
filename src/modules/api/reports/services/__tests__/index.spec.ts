import * as reportServices from "../index";
import { ReportsService } from "../reports.service";

describe("reports service index exports", () => {
    it("re-exports ReportsService", () => {
        expect(reportServices.ReportsService).toBe(ReportsService);
    });
});