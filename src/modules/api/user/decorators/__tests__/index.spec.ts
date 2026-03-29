import { ROUTE_ARGS_METADATA } from "@nestjs/common/constants";
import { User, ClientData } from "../index";

describe("User decorators", () => {
    class TestController {
        test(@User("id") _userId: unknown, @ClientData() _client: unknown) {
            return undefined;
        }
    }

    function getDecoratorFactories() {
        const metadata = Reflect.getMetadata(ROUTE_ARGS_METADATA, TestController, "test");
        const entries = Object.values(metadata) as Array<{ data?: unknown; factory?: Function }>;

        const userFactory = entries.find((e) => e.data === "id" && typeof e.factory === "function")?.factory;
        const clientFactory = entries.find((e) => e.data === undefined && typeof e.factory === "function")?.factory;

        return { userFactory, clientFactory };
    }

    it("extracts user field from request context", () => {
        const { userFactory } = getDecoratorFactories();
        const ctx = {
            switchToHttp: () => ({
                getRequest: () => ({ user: { id: 42, email: "u@example.com" }, ip: "127.0.0.1" }),
            }),
        } as any;

        expect(userFactory).toBeDefined();
        expect(userFactory?.("id", ctx)).toBe(42);
    });

    it("returns client data with ipAddress", () => {
        const { clientFactory } = getDecoratorFactories();
        const ctx = {
            switchToHttp: () => ({
                getRequest: () => ({ ip: "10.0.0.2" }),
            }),
        } as any;

        expect(clientFactory).toBeDefined();
        expect(clientFactory?.(undefined, ctx)).toEqual({ ipAddress: "10.0.0.2" });
    });
});
