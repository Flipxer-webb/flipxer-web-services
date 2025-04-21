import { HttpException } from "@nestjs/common";

export class WalletAddressNotFoundException extends HttpException {
    name = "WalletAddressNotFoundException";
}
