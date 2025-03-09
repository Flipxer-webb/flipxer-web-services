export interface DojahOptions {
    baseURL: string;
    appId: string;
    apiKey: string;
}

export interface VerifyBvnOptions {
    bvn: string;
    first_name?: string;
    last_name?: string;
    dob?: string;
}

export interface VerifyBvnResponseData {
    entity: {
        bvn: string;
        first_name: string;
        last_name: string;
        middle_name: string;
        gender: string;
        date_of_birth: string;
        phone_number1: string;
        image: string;
        phone_number2: string;
    };
}

export interface DojahResponse<
    D extends Record<string, any> = Record<string, any>
> {
    status: boolean;
    responseCode: number;
    data: D;
}
