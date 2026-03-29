import {
    WsAuthTokenValidationException,
    WsMissingAuthorizationToken,
    WsPrismaNetworkException,
    WsUserNotFoundException,
} from "../ws";

describe("Auth websocket errors", () => {
    it("builds websocket auth exceptions", () => {
        const tokenValidation = new WsAuthTokenValidationException("bad token");
        expect(tokenValidation.name).toBe("WsAuthTokenValidationException");
        expect(tokenValidation.getError()).toBe("bad token");

        const missingToken = new WsMissingAuthorizationToken("missing token");
        expect(missingToken.name).toBe("WsMissingAuthorizationToken");
        expect(missingToken.getError()).toBe("missing token");

        const userMissing = new WsUserNotFoundException("missing user");
        expect(userMissing.name).toBe("WsUserNotFoundException");
        expect(userMissing.getError()).toBe("missing user");

        const prismaNetwork = new WsPrismaNetworkException("network down");
        expect(prismaNetwork.name).toBe("WsPrismaNetworkException");
        expect(prismaNetwork.getError()).toBe("network down");
    });
});
