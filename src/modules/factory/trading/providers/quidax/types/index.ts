import * as QD from "@/libs/quidax";
export interface InstantOrdersRequeryOptions {
    instant_order_id: string;
    user_id: string;
}

export interface IQuidaxService {
    instantOrdersRequery(
        options: InstantOrdersRequeryOptions
    ): Promise<QD.QuidaxResponse<QD.InstantOrderResponse>>;
}
