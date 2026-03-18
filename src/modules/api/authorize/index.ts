import { Module } from "@nestjs/common";
import AuthorizationService from "./services/authorize.service";
import AuthorizationController from "./controllers/v1";
import { AuthModule } from "../auth";
import { SessionModule } from "../session";

@Module({
    imports: [AuthModule, SessionModule],
    providers: [AuthorizationService],
    controllers: [AuthorizationController],
})
export class AuthorizeModule {}
