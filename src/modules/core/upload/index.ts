import { Global, Module } from "@nestjs/common";
import { UploadFactory } from "./services";

@Global()
@Module({
    providers: [UploadFactory],
    exports: [UploadFactory],
})
export class UploadModule {}
