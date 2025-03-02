import { Module } from "@nestjs/common";
import { AuthModule } from "./auth";
import { AuthorizeModule } from "./authorize";
import { UserModule } from "./user";
import { WebExtension } from "./webExtension";

@Module({
    imports: [WebExtension, UserModule, AuthModule, AuthorizeModule],
})
export class APIModule {}
