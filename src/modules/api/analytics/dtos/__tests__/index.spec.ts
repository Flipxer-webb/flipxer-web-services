import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import {
    GetAnalyticsDto,
    GetAssetDistributionDto,
    GetChartDataDto,
    GetRevenueAnalyticsDto,
    GetUserGrowthDto,
} from "../index";

describe("Analytics DTOs", () => {
    it("accepts valid analytics period", async () => {
        const dto = new GetAnalyticsDto();
        dto.period = "month";

        const errors = await validate(dto);

        expect(errors).toHaveLength(0);
    });

    it("rejects invalid analytics period", async () => {
        const dto = new GetAnalyticsDto();
        dto.period = "invalid-period" as any;

        const errors = await validate(dto);

        expect(errors.map((error) => error.property)).toContain("period");
    });

    it("accepts chart, growth, and revenue optional fields", async () => {
        const chart = new GetChartDataDto();
        chart.granularity = "daily";
        chart.category = "BUY";

        const growth = new GetUserGrowthDto();
        growth.userType = "INDIVIDUAL";

        const revenue = new GetRevenueAnalyticsDto();
        revenue.source = "fees";
        revenue.currency = "NGN";

        await expect(validate(chart)).resolves.toHaveLength(0);
        await expect(validate(growth)).resolves.toHaveLength(0);
        await expect(validate(revenue)).resolves.toHaveLength(0);
    });

    it("converts numeric limit for asset distribution", async () => {
        const dto = plainToInstance(GetAssetDistributionDto, { limit: "10" });

        const errors = await validate(dto);

        expect(errors).toHaveLength(0);
        expect(dto.limit).toBe(10);
    });
});
