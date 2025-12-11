export interface SendchampOptions {
    accessKey: string;
    baseUrl?: string;
}

export interface SendSmsRequest {
    to: string | string[];
    message: string;
    sender_name: string;
    route?: "non_dnd" | "dnd" | "international";
}

export interface SendSmsResponse {
    code: number;
    message: string;
    status: string;
    data: {
        id: string;
        phone_number: string;
        reference: string;
        status: string;
    };
}

export interface SendchampApiError {
    code: number;
    message: string;
    status: string;
    errors?: Record<string, string[]>;
}
