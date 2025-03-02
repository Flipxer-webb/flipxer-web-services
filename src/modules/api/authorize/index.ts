import { Module } from "@nestjs/common";
import AuthorizationService from "./services/authorize.service";
import AuthorizationController from "./controllers/v1";

@Module({
    providers: [AuthorizationService],
    controllers: [AuthorizationController],
})
export class AuthorizeModule {}
