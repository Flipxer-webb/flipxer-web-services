const analyticsModuleStub = { name: "AnalyticsModuleStub" };
const analyticsControllerStub = { name: "AnalyticsControllerStub" };
const analyticsServiceStub = { name: "AnalyticsServiceStub" };

jest.mock("../analytics.module", () => ({
    AnalyticsModule: analyticsModuleStub,
    __esModule: true,
}));

jest.mock("../controllers", () => ({
    AnalyticsController: analyticsControllerStub,
    __esModule: true,
}));

jest.mock("../services", () => ({
    AnalyticsService: analyticsServiceStub,
    __esModule: true,
}));

import * as analyticsIndex from "../index";

describe("analytics index exports", () => {
    it("re-exports module/controller/service symbols", () => {
        expect(analyticsIndex.AnalyticsModule).toBe(analyticsModuleStub);
        expect(analyticsIndex.AnalyticsController).toBe(analyticsControllerStub);
        expect(analyticsIndex.AnalyticsService).toBe(analyticsServiceStub);
    });
});
