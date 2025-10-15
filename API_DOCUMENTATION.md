# API Documentation - Resolve Web Services

## Table of Contents
- [Getting Started](#getting-started)
- [Authentication](#authentication)
- [API Endpoints](#api-endpoints)
- [Common Response Formats](#common-response-formats)
- [Error Handling](#error-handling)
- [Rate Limiting](#rate-limiting)
- [WebSocket Connection](#websocket-connection)
- [Webhooks](#webhooks)
- [Code Examples](#code-examples)

---

## Getting Started

### Base URL

```
Development: http://localhost:3500
Production: https://api.yourdomain.com
```

### API Versioning

All API endpoints are versioned with the prefix `/api/v1/`:

```
GET /api/v1/users/profile
POST /api/v1/auth/login
```

### Interactive Documentation

Once the server is running, access the Swagger UI at:

```
http://localhost:3500/api
```

This provides:
- Complete endpoint reference
- Request/response schemas
- Try-it-out functionality
- Authentication testing

---

## Authentication

### Overview

The API uses JWT (JSON Web Token) based authentication with two token types:

1. **Access Token**: Short-lived (15-60 min), used for API requests
2. **Refresh Token**: Long-lived (7-30 days), used to get new access tokens

### Registration

**Endpoint**: `POST /api/v1/auth/register`

**Request Body**:
```json
{
  "email": "user@example.com",
  "password": "SecurePass123!",
  "firstName": "John",
  "lastName": "Doe",
  "phone": "+2348012345678",
  "userType": "INDIVIDUAL"
}
```

**Response** (201 Created):
```json
{
  "success": true,
  "message": "Registration successful",
  "data": {
    "user": {
      "id": 1,
      "email": "user@example.com",
      "firstName": "John",
      "lastName": "Doe",
      "isEmailVerified": false
    }
  }
}
```

### Login

**Endpoint**: `POST /api/v1/auth/login`

**Request Body**:
```json
{
  "email": "user@example.com",
  "password": "SecurePass123!"
}
```

**Response** (200 OK):
```json
{
  "success": true,
  "message": "Login successful",
  "data": {
    "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "user": {
      "id": 1,
      "email": "user@example.com",
      "firstName": "John",
      "lastName": "Doe",
      "role": "USER"
    }
  }
}
```

### Using Access Tokens

Include the access token in the `Authorization` header for all authenticated requests:

```http
GET /api/v1/users/profile
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

### Token Refresh

**Endpoint**: `POST /api/v1/auth/refresh`

**Request Body**:
```json
{
  "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
  }
}
```

### Logout

**Endpoint**: `POST /api/v1/auth/logout`

**Headers**:
```
Authorization: Bearer <access_token>
```

**Response** (200 OK):
```json
{
  "success": true,
  "message": "Logout successful"
}
```

---

## API Endpoints

### Authentication Endpoints

| Method | Endpoint | Description | Auth Required |
|--------|----------|-------------|---------------|
| POST | `/api/v1/auth/register` | Register new user | No |
| POST | `/api/v1/auth/login` | User login | No |
| POST | `/api/v1/auth/logout` | User logout | Yes |
| POST | `/api/v1/auth/refresh` | Refresh access token | No |
| POST | `/api/v1/auth/forgot-password` | Request password reset | No |
| POST | `/api/v1/auth/reset-password` | Reset password with token | No |
| POST | `/api/v1/auth/verify-email` | Verify email address | No |
| POST | `/api/v1/auth/resend-verification` | Resend verification email | No |

### User Management Endpoints

| Method | Endpoint | Description | Auth Required |
|--------|----------|-------------|---------------|
| GET | `/api/v1/users/profile` | Get current user profile | Yes |
| PUT | `/api/v1/users/profile` | Update user profile | Yes |
| POST | `/api/v1/users/upload-photo` | Upload profile photo | Yes |
| POST | `/api/v1/users/upload-document` | Upload KYC documents | Yes |
| GET | `/api/v1/users/documents` | Get user documents | Yes |
| POST | `/api/v1/users/verify-bvn` | Verify Bank Verification Number | Yes |
| GET | `/api/v1/users/kyc-status` | Get KYC verification status | Yes |

### Trading Endpoints

| Method | Endpoint | Description | Auth Required |
|--------|----------|-------------|---------------|
| GET | `/api/v1/trade/markets` | Get available trading markets | Yes |
| GET | `/api/v1/trade/market/:pair` | Get market details | Yes |
| POST | `/api/v1/trade/order` | Place buy/sell order | Yes |
| GET | `/api/v1/trade/orders` | Get user orders | Yes |
| GET | `/api/v1/trade/order/:id` | Get order details | Yes |
| DELETE | `/api/v1/trade/order/:id` | Cancel order | Yes |
| GET | `/api/v1/trade/wallets` | Get user wallets | Yes |
| GET | `/api/v1/trade/wallet/:asset` | Get specific wallet | Yes |

### Transaction Endpoints

| Method | Endpoint | Description | Auth Required |
|--------|----------|-------------|---------------|
| GET | `/api/v1/transactions` | Get transaction history | Yes |
| GET | `/api/v1/transactions/:id` | Get transaction details | Yes |
| GET | `/api/v1/transactions/stats` | Get transaction statistics | Yes |
| POST | `/api/v1/transactions/deposit` | Initiate deposit | Yes |
| POST | `/api/v1/transactions/withdraw` | Initiate withdrawal | Yes |

### Bank Account Endpoints

| Method | Endpoint | Description | Auth Required |
|--------|----------|-------------|---------------|
| GET | `/api/v1/banks` | Get list of supported banks | Yes |
| POST | `/api/v1/banks/account` | Add bank account | Yes |
| GET | `/api/v1/banks/accounts` | Get user bank accounts | Yes |
| DELETE | `/api/v1/banks/account/:id` | Remove bank account | Yes |
| POST | `/api/v1/banks/verify-account` | Verify bank account | Yes |

### Notification Endpoints

| Method | Endpoint | Description | Auth Required |
|--------|----------|-------------|---------------|
| GET | `/api/v1/notifications` | Get user notifications | Yes |
| GET | `/api/v1/notifications/:id` | Get notification details | Yes |
| PUT | `/api/v1/notifications/:id/read` | Mark notification as read | Yes |
| PUT | `/api/v1/notifications/read-all` | Mark all notifications as read | Yes |
| DELETE | `/api/v1/notifications/:id` | Delete notification | Yes |

### Settings Endpoints

| Method | Endpoint | Description | Auth Required |
|--------|----------|-------------|---------------|
| GET | `/api/v1/settings` | Get user settings | Yes |
| PUT | `/api/v1/settings` | Update user settings | Yes |
| POST | `/api/v1/settings/change-password` | Change password | Yes |
| POST | `/api/v1/settings/2fa/enable` | Enable 2FA | Yes |
| POST | `/api/v1/settings/2fa/disable` | Disable 2FA | Yes |

### Admin Endpoints

| Method | Endpoint | Description | Auth Required | Role |
|--------|----------|-------------|---------------|------|
| GET | `/api/v1/auth/admin/users` | Get all users | Yes | ADMIN |
| GET | `/api/v1/auth/admin/user/:id` | Get user details | Yes | ADMIN |
| PUT | `/api/v1/auth/admin/user/:id/status` | Update user status | Yes | ADMIN |
| GET | `/api/v1/transactions/admin/all` | Get all transactions | Yes | ADMIN |
| GET | `/api/v1/notifications/admin/send` | Send notification | Yes | ADMIN |

---

## Common Response Formats

### Success Response

```json
{
  "success": true,
  "message": "Operation successful",
  "data": {
    // Response data here
  }
}
```

### Paginated Response

```json
{
  "success": true,
  "message": "Data retrieved successfully",
  "data": {
    "items": [...],
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 100,
      "totalPages": 5,
      "hasNext": true,
      "hasPrev": false
    }
  }
}
```

### Pagination Query Parameters

```
GET /api/v1/transactions?page=2&limit=50&sortBy=createdAt&order=desc
```

Parameters:
- `page` (default: 1): Page number
- `limit` (default: 20): Items per page
- `sortBy` (optional): Field to sort by
- `order` (optional): `asc` or `desc`

---

## Error Handling

### Error Response Format

```json
{
  "success": false,
  "message": "Error description",
  "error": {
    "code": "ERROR_CODE",
    "details": "Additional error details"
  }
}
```

### HTTP Status Codes

| Status Code | Description |
|-------------|-------------|
| 200 | Success |
| 201 | Created |
| 204 | No Content |
| 400 | Bad Request (validation error) |
| 401 | Unauthorized (invalid/missing token) |
| 403 | Forbidden (insufficient permissions) |
| 404 | Not Found |
| 409 | Conflict (e.g., duplicate email) |
| 422 | Unprocessable Entity (validation failed) |
| 429 | Too Many Requests (rate limit exceeded) |
| 500 | Internal Server Error |
| 503 | Service Unavailable |

### Common Error Codes

```json
{
  "AUTH_001": "Invalid credentials",
  "AUTH_002": "Token expired",
  "AUTH_003": "Invalid token",
  "AUTH_004": "Email not verified",

  "USER_001": "User not found",
  "USER_002": "User already exists",
  "USER_003": "KYC verification required",

  "TRADE_001": "Insufficient balance",
  "TRADE_002": "Invalid trading pair",
  "TRADE_003": "Order not found",

  "BANK_001": "Bank account already exists",
  "BANK_002": "Bank account verification failed",

  "VALIDATION_001": "Invalid input data"
}
```

### Validation Error Example

```json
{
  "success": false,
  "message": "Validation failed",
  "errors": [
    {
      "field": "email",
      "message": "Must be a valid email address"
    },
    {
      "field": "password",
      "message": "Must be at least 8 characters"
    }
  ]
}
```

---

## Rate Limiting

**Note**: Rate limiting needs to be implemented before production (see [SECURITY.md](./SECURITY.md)).

### Recommended Limits

- **Authentication endpoints**: 5 requests per minute
- **Public endpoints**: 100 requests per minute
- **Authenticated endpoints**: 1000 requests per hour

### Rate Limit Headers (when implemented)

```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1640000000
```

### Rate Limit Exceeded Response (429)

```json
{
  "success": false,
  "message": "Too many requests. Please try again later.",
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "retryAfter": 60
  }
}
```

---

## WebSocket Connection

### Connection

Connect to WebSocket server for real-time updates:

```javascript
const socket = io('ws://localhost:3500', {
  auth: {
    token: 'your-access-token'
  }
});
```

### Events

#### Subscribe to Market Updates

```javascript
// Join a market room
socket.emit('subscribe', { market: 'BTC-USDT' });

// Listen for price updates
socket.on('market:update', (data) => {
  console.log('Price update:', data);
  // { market: 'BTC-USDT', price: 50000, volume: 1234.56 }
});
```

#### Subscribe to Order Updates

```javascript
// Listen for order status changes
socket.on('order:update', (data) => {
  console.log('Order update:', data);
  // { orderId: 123, status: 'FILLED', filledAmount: 0.5 }
});
```

#### Notifications

```javascript
// Listen for notifications
socket.on('notification', (data) => {
  console.log('New notification:', data);
  // { id: 456, type: 'TRANSACTION', message: 'Deposit successful' }
});
```

### Disconnection

```javascript
socket.disconnect();
```

---

## Webhooks

### Paystack Webhook

**Endpoint**: `POST /webhook/paystack`

Receives payment notifications from Paystack.

**Headers**:
```
x-paystack-signature: <signature>
```

**Events Handled**:
- `charge.success` - Payment successful
- `transfer.success` - Transfer successful
- `transfer.failed` - Transfer failed

### Quidax Webhook

**Endpoint**: `POST /webhook/quidax`

Receives cryptocurrency transaction notifications from Quidax.

**Headers**:
```
x-quidax-signature: <signature>
```

**Events Handled**:
- `order.filled` - Order executed
- `deposit.confirmed` - Crypto deposit confirmed
- `withdrawal.completed` - Crypto withdrawal completed

---

## Code Examples

### JavaScript/TypeScript (Fetch)

```typescript
// Login example
async function login(email: string, password: string) {
  const response = await fetch('http://localhost:3500/api/v1/auth/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, password }),
  });

  if (!response.ok) {
    throw new Error('Login failed');
  }

  const data = await response.json();
  return data.data; // { accessToken, refreshToken, user }
}

// Authenticated request example
async function getUserProfile(accessToken: string) {
  const response = await fetch('http://localhost:3500/api/v1/users/profile', {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error('Failed to fetch profile');
  }

  return await response.json();
}
```

### JavaScript (Axios)

```javascript
const axios = require('axios');

const api = axios.create({
  baseURL: 'http://localhost:3500/api/v1',
});

// Add token to all requests
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('accessToken');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Usage
async function placeOrder(orderData) {
  try {
    const response = await api.post('/trade/order', orderData);
    return response.data;
  } catch (error) {
    console.error('Order failed:', error.response.data);
    throw error;
  }
}
```

### Python (Requests)

```python
import requests

BASE_URL = 'http://localhost:3500/api/v1'

# Login
def login(email, password):
    response = requests.post(f'{BASE_URL}/auth/login', json={
        'email': email,
        'password': password
    })
    response.raise_for_status()
    return response.json()['data']

# Authenticated request
def get_user_profile(access_token):
    headers = {'Authorization': f'Bearer {access_token}'}
    response = requests.get(f'{BASE_URL}/users/profile', headers=headers)
    response.raise_for_status()
    return response.json()['data']
```

### cURL

```bash
# Login
curl -X POST http://localhost:3500/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com",
    "password": "SecurePass123!"
  }'

# Get profile (authenticated)
curl -X GET http://localhost:3500/api/v1/users/profile \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."

# Place order
curl -X POST http://localhost:3500/api/v1/trade/order \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "pair": "BTC-USDT",
    "type": "BUY",
    "amount": 0.01,
    "price": 50000
  }'
```

---

## Best Practices

### 1. Token Management

- Store access tokens securely (httpOnly cookies preferred)
- Implement automatic token refresh before expiration
- Clear tokens on logout

### 2. Error Handling

- Always check `success` field in response
- Handle common HTTP status codes appropriately
- Display user-friendly error messages

### 3. Request Optimization

- Use pagination for large datasets
- Cache responses when appropriate
- Debounce search/filter requests

### 4. Security

- Never log or expose access tokens
- Use HTTPS in production
- Validate and sanitize user input
- Implement request timeouts

---

## Testing the API

### Using Swagger UI

1. Start the server: `pnpm run start:dev`
2. Open browser: `http://localhost:3500/api`
3. Click "Authorize" and enter your access token
4. Try any endpoint with "Try it out"

### Using Postman

1. Import the API schema from Swagger JSON: `http://localhost:3500/api-json`
2. Set up environment variables:
   - `baseUrl`: `http://localhost:3500`
   - `accessToken`: (set after login)
3. Create a collection with pre-request scripts for auto-token refresh

### Example Postman Pre-request Script

```javascript
// Auto-refresh token if expired
const token = pm.environment.get('accessToken');
if (isTokenExpired(token)) {
  const refreshToken = pm.environment.get('refreshToken');
  // Call refresh endpoint and update tokens
}
```

---

## Support & Feedback

For API support or to report issues:

- **Email**: ibukunolaoluwa402@gmail.com
- **GitHub Issues**: [https://github.com/OmeriHQ/resolve-web-services/issues](https://github.com/OmeriHQ/resolve-web-services/issues)

For real-time API status and updates, check the Swagger documentation at `/api`.

---

## Changelog

Track API changes and versioning:

### v1.0.0 (Current)
- Initial API release
- Authentication & user management
- Trading functionality
- Payment integration
- KYC/identity verification

Future versions will be documented here with breaking changes highlighted.

---

**Happy Coding! 🚀**
