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

export interface VerifyNinOptions {
    nin: string;
    first_name?: string;
    last_name?: string;
    dob?: string;
}

export interface VerifyNinResponseData {
    entity: {
        nin: string;
        first_name: string;
        last_name: string;
        middle_name: string;
        gender: string;
        date_of_birth: string;
        phone_number: string;
        photo: string;
    };
}

export interface DojahResponse<
    D extends Record<string, any> = Record<string, any>
> {
    status: boolean;
    responseCode: number;
    data: D;
}

// Document Analysis Types
export interface DocumentAnalysisOptions {
    /** Base64 or URL of the document front side */
    imageFrontSide: string;
    /** Base64 or URL of the document back side (optional) */
    imageBackSide?: string;
    /** Input type: 'url' or 'base64', defaults to 'base64' */
    inputType?: "url" | "base64";
}

export interface DocumentAnalysisTextField {
    field_name: string;
    field_key: string;
    /** 1 = valid, 0 = invalid, 2 = not applicable */
    status: number;
    value: string;
}

export interface DocumentAnalysisStatus {
    /** 1 = valid, 0 = invalid */
    overall_status: number;
    reason: "VALID" | "NOT_VALID" | string;
    document_images: "Yes" | "No";
    text: "Yes" | "No";
    document_type: "Yes" | "No";
    expiry: "Yes" | "No";
}

export interface DocumentAnalysisDocumentType {
    document_name: string;
    document_country_name: string;
    document_country_code: string;
}

export interface DocumentAnalysisImages {
    portrait?: string;
    document_front_side?: string;
    document_back_side?: string;
}

export interface DocumentAnalysisEntity {
    status: DocumentAnalysisStatus;
    document_type: DocumentAnalysisDocumentType;
    document_images: DocumentAnalysisImages;
    text_data: DocumentAnalysisTextField[];
}

export interface DocumentAnalysisResponseData {
    entity: DocumentAnalysisEntity;
}

/** Parsed document data for easier consumption */
export interface ParsedDocumentData {
    isValid: boolean;
    reason: string;
    documentType: string;
    country: string;
    countryCode: string;
    firstName?: string;
    lastName?: string;
    givenNames?: string;
    documentNumber?: string;
    dateOfBirth?: string;
    expiryDate?: string;
    issueDate?: string;
    sex?: string;
    nationality?: string;
    placeOfBirth?: string;
    address?: string;
    hasPortrait: boolean;
    hasFrontSide: boolean;
    hasBackSide: boolean;
}
