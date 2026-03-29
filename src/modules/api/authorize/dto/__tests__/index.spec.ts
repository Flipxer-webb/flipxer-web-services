import { validate } from "class-validator";
import { PermissionDto } from "../index";

describe("PermissionDto", () => {
    it("passes validation for valid values", async () => {
        const dto = new PermissionDto();
        dto.id = 1;
        dto.name = "manage_users";
        dto.description = "Can manage users";

        const errors = await validate(dto);

        expect(errors).toHaveLength(0);
    });

    it("fails validation for invalid values", async () => {
        const dto = new PermissionDto();
        dto.id = Number.NaN as unknown as number;
        dto.name = 123 as unknown as string;
        dto.description = false as unknown as string;

        const errors = await validate(dto);
        const properties = errors.map((error) => error.property);

        expect(properties).toEqual(expect.arrayContaining(["id", "name", "description"]));
    });
});
