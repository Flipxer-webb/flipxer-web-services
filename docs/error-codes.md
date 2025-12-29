# Flipxer Error Code Catalog

This document describes all error codes used in the Flipxer API and their corresponding user-friendly messages.

## Overview

The error response format is:
```json
{
  "success": false,
  "message": "User-friendly error message",
  "code": "ERROR_CODE",
  "errors": [...] // Only for validation errors
}
```

The `code` field allows frontend applications to reliably identify error types without pattern matching on messages.

---

## Authentication Errors

| Code | HTTP Status | User Message |
|------|-------------|--------------|
| `INVALID_CREDENTIALS` | 400/401 | The email or password you entered is incorrect. |
| `ACCOUNT_LOCKED` | 403 | Your account has been temporarily locked. Please try again later. |
| `ACCOUNT_DISABLED` | 403 | Your account has been disabled. Please contact support. |
| `ACCOUNT_FLAGGED` | 403 | Your account has been flagged for review. Please contact support. |
| `SESSION_EXPIRED` | 401 | Your session has expired. Please log in again. |
| `INVALID_TOKEN` | 401 | Your session is invalid. Please log in again. |
| `UNAUTHORIZED` | 401 | Please log in to continue. |
| `FORBIDDEN` | 403 | You don't have permission to perform this action. |

---

## Two-Factor Authentication Errors

| Code | HTTP Status | User Message |
|------|-------------|--------------|
| `TWO_FACTOR_REQUIRED` | 401 | Two-factor authentication is required. |
| `INVALID_2FA_CODE` | 400 | The verification code you entered is incorrect. |
| `TWO_FACTOR_LOCKED` | 429 | Too many failed attempts. Please wait and try again. |
| `INVALID_BACKUP_CODE` | 400 | The backup code you entered is incorrect. |
| `TWO_FACTOR_NOT_ENABLED` | 400 | Two-factor authentication is not enabled for this account. |

---

## Email / OTP Verification Errors

| Code | HTTP Status | User Message |
|------|-------------|--------------|
| `INVALID_OTP` | 400 | The verification code you entered is incorrect. |
| `OTP_EXPIRED` | 400 | The verification code has expired. Please request a new one. |
| `EMAIL_NOT_VERIFIED` | 403 | Please verify your email address to continue. |
| `PHONE_NOT_VERIFIED` | 403 | Please verify your phone number to continue. |

---

## Identity Verification (KYC) Errors

| Code | HTTP Status | User Message |
|------|-------------|--------------|
| `BVN_VERIFICATION_FAILED` | 400 | We couldn't verify your BVN. Please check and try again. |
| `NIN_VERIFICATION_FAILED` | 400 | We couldn't verify your NIN. Please check and try again. |
| `DOCUMENT_VERIFICATION_FAILED` | 400 | We couldn't verify your document. Please try again with a clearer image. |
| `VERIFICATION_REQUIRED` | 403 | Please complete verification to access this feature. |
| `DUPLICATE_VERIFICATION` | 409 | This identity has already been verified. |
| `DETAILS_MISMATCH` | 400 | The details provided don't match your official records. |

---

## Bank Account Errors

| Code | HTTP Status | User Message |
|------|-------------|--------------|
| `INVALID_ACCOUNT_NUMBER` | 400 | Please enter a valid 10-digit account number. |
| `BANK_NOT_FOUND` | 404 | We couldn't find that bank. Please select from the list. |
| `ACCOUNT_VERIFICATION_FAILED` | 400 | We couldn't verify this account. Please check the details. |
| `ACCOUNT_NAME_MISMATCH` | 400 | The account name doesn't match your profile. |
| `BANK_ACCOUNT_EXISTS` | 409 | This bank account has already been added. |

---

## Transaction Errors

| Code | HTTP Status | User Message |
|------|-------------|--------------|
| `INSUFFICIENT_BALANCE` | 400 | You don't have enough funds for this transaction. |
| `DAILY_LIMIT_EXCEEDED` | 400 | You've reached your daily transaction limit. |
| `MINIMUM_AMOUNT` | 400 | The amount is below the minimum allowed. |
| `MAXIMUM_AMOUNT` | 400 | The amount exceeds the maximum allowed. |
| `TRANSACTION_FAILED` | 500 | This transaction couldn't be completed. Please try again. |
| `QUOTE_EXPIRED` | 400 | The quote has expired. Please refresh to get a new rate. |
| `INVALID_WALLET_ADDRESS` | 400 | The wallet address you entered is invalid. |
| `DUPLICATE_TRANSACTION` | 409 | This looks like a duplicate transaction. Please wait a moment. |

---

## Validation Errors

| Code | HTTP Status | User Message |
|------|-------------|--------------|
| `VALIDATION_ERROR` | 422 | Please check your information and try again. |
| `MISSING_REQUIRED_FIELD` | 400 | Please fill in all required fields. |
| `INVALID_INPUT` | 400 | The information provided is invalid. Please check and try again. |

---

## Rate Limiting Errors

| Code | HTTP Status | User Message |
|------|-------------|--------------|
| `RATE_LIMITED` | 429 | Too many requests. Please wait a moment and try again. |
| `TOO_MANY_ATTEMPTS` | 429 | Too many attempts. Please wait a few minutes and try again. |

---

## Resource Errors

| Code | HTTP Status | User Message |
|------|-------------|--------------|
| `NOT_FOUND` | 404 | The requested resource was not found. |
| `CONFLICT` | 409 | This action conflicts with an existing record. |

---

## System Errors

| Code | HTTP Status | User Message |
|------|-------------|--------------|
| `SERVER_ERROR` | 500 | Something went wrong on our end. Please try again. |
| `DATABASE_ERROR` | 500 | System error. Please try again later. |
| `EXTERNAL_SERVICE_ERROR` | 503 | An external service is temporarily unavailable. Please try again. |
| `UNKNOWN_ERROR` | 500 | Something went wrong. Please try again. |

---

## Backend Usage

```typescript
import { ErrorCode } from "@/core/exception/error-codes";
import { HttpException, HttpStatus } from "@nestjs/common";

// Throw with structured error
throw new HttpException(
  { message: "Invalid verification code", code: ErrorCode.INVALID_2FA_CODE },
  HttpStatus.BAD_REQUEST
);
```

## Frontend Usage

The frontend `error-handler.ts` automatically:
1. Checks `error.code` against `API_ERROR_CODES` map
2. Falls back to pattern matching on `error.message`
3. Falls back to HTTP status code messages
4. Falls back to default error message

```typescript
import { handleApiError } from "@/lib/error-handler";

mutation.mutate(data, {
  onError: handleApiError, // Shows user-friendly toast
});
```
