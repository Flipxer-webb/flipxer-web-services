# Environment Variables Documentation

Complete reference for all environment variables used in Flipxer Web Services.

## Table of Contents
- [Quick Start](#quick-start)
- [Application Settings](#application-settings)
- [Database Configuration](#database-configuration)
- [Security & Authentication](#security--authentication)
- [Redis Cache](#redis-cache)
- [Third-Party Services](#third-party-services)
- [Email Configuration](#email-configuration)
- [Advanced Configuration](#advanced-configuration)

---

## Quick Start

1. Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```

2. Fill in required values (marked with ⚠️ below)
3. Generate secure secrets for production
4. Never commit `.env` to version control!

---

## Application Settings

### `PORT` ⚠️
- **Type**: Number
- **Default**: `3500`
- **Description**: Port where the API server will listen
- **Example**: `3500`

### `NODE_ENV` ⚠️
- **Type**: String
- **Options**: `development`, `production`, `test`
- **Default**: `development`
- **Description**: Node.js environment mode
- **Example**: `production`

### `ENVIRONMENT` ⚠️
- **Type**: String
- **Options**: `development`, `production`, `staging`
- **Default**: `development`
- **Description**: Application environment (used for feature flags)
- **Example**: `production`

### `BASEURL` ⚠️
- **Type**: URL
- **Description**: Base URL of your API (used in emails, webhooks)
- **Example**: `https://api.yourdomain.com`
- **Development**: `http://localhost:3500`

### `ALLOWED_DOMAINS` ⚠️
- **Type**: Comma-separated URLs
- **Description**: Frontend domains allowed to access the API (CORS)
- **Example**: `https://app.yourdomain.com,https://www.yourdomain.com`
- **Development**: `http://localhost:3000,http://localhost:3008`
- **Important**: NO trailing slashes!

### `FRONTEND_DEV_DOMAIN`
- **Type**: URL
- **Description**: Development frontend URL (automatically added to CORS in dev mode)
- **Example**: `http://localhost:3008`

### `BLOCKED_COUNTRIES`
- **Type**: Comma-separated ISO 3166-1 alpha-2 country codes
- **Description**: Countries blocked from accessing the service
- **Example**: `AF,BY,BA,CF,CU,CD,ER,GW,IR,IQ`
- **Purpose**: Compliance with international sanctions and regulations

---

## Database Configuration

### `DATABASE_URL` ⚠️
- **Type**: PostgreSQL connection string
- **Format**: `postgresql://USERNAME:PASSWORD@HOST:PORT/DATABASE?sslmode=require`
- **Description**: Main database connection
- **Example**: `postgresql://user:pass@db.example.com:5432/flipxer_prod?sslmode=require`
- **Important**: Always use `sslmode=require` in production!

### `SHADOW_DATABASE_URL` ⚠️
- **Type**: PostgreSQL connection string
- **Description**: Shadow database for Prisma migrations (development only)
- **Example**: `postgresql://user:pass@db.example.com:5432/flipxer_shadow?sslmode=require`
- **Note**: Can use same credentials as DATABASE_URL, different database name

---

## Security & Authentication

### `JWT_SECRET` ⚠️
- **Type**: String (minimum 32 characters)
- **Description**: Secret key for signing JWT access tokens
- **Example**: `a7f3c9e2b8d4f1a6e5c7b9d2f8e4a1c6b3d9f7e2a5c8b1d4f6e9a2c7b5d8f1e3`
- **Generate**: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
- **CRITICAL**: Use different values for dev and production!

### `JWT_REFRESH_SECRET` ⚠️
- **Type**: String (minimum 32 characters)
- **Description**: Secret key for signing JWT refresh tokens
- **Example**: `b8f4d1a7e6c9b2d5f8e1a4c7b9d3f6e2a8c5b1d7f9e4a2c6b8d1f5e7a3c9b2d4`
- **Generate**: Same as JWT_SECRET (but use different value!)

### `ENCRYPT_SECRET` ⚠️
- **Type**: String (minimum 32 characters)
- **Description**: Secret key for encrypting sensitive data (AES encryption)
- **Example**: `c9f5e2a8b7d1f4e6a3c9b5d8f2e7a1c4b6d9f3e8a5c2b7d1f6e9a4c8b2d5f1e3`
- **Generate**: Same as JWT_SECRET (but use different value!)

---

## Redis Cache

### `REDIS_HOST` ⚠️
- **Type**: Hostname or IP
- **Description**: Redis server hostname
- **Example**: `redis.example.com` or `127.0.0.1`

### `REDIS_PORT`
- **Type**: Number
- **Default**: `6379`
- **Description**: Redis server port
- **Example**: `6379`

### `REDIS_USER`
- **Type**: String
- **Default**: `default`
- **Description**: Redis username (Redis 6+)
- **Example**: `default` or `redis_user`

### `REDIS_PASSWORD` ⚠️
- **Type**: String
- **Description**: Redis authentication password
- **Example**: `your-strong-redis-password`
- **Important**: Always use password in production!

---

## Third-Party Services

### Cloudinary (Image Storage)

#### `CLOUDINARY_CLOUD_NAME` ⚠️
- **Type**: String
- **Description**: Your Cloudinary cloud name
- **Get From**: Cloudinary Dashboard
- **Example**: `your-cloud-name`

#### `CLOUDINARY_API_KEY` ⚠️
- **Type**: String
- **Description**: Cloudinary API key
- **Get From**: Cloudinary Dashboard > Settings > API Keys
- **Example**: `123456789012345`

#### `CLOUDINARY_API_SECRET` ⚠️
- **Type**: String
- **Description**: Cloudinary API secret
- **Get From**: Cloudinary Dashboard > Settings > API Keys
- **Example**: `abcdefghijklmnopqrstuvwxyz`

### ImageKit (Alternative Image Service)

#### `IMAGEKIT_URL` ⚠️
- **Type**: URL
- **Description**: Your ImageKit URL endpoint
- **Get From**: ImageKit Dashboard
- **Example**: `https://ik.imagekit.io/your-imagekit-id`

#### `IMAGEKIT_PUBLIC_KEY` ⚠️
- **Type**: String
- **Description**: ImageKit public key
- **Get From**: ImageKit Dashboard > Developer Options
- **Example**: `public_abc123def456ghi789`

#### `IMAGEKIT_PRIVATE_KEY` ⚠️
- **Type**: String
- **Description**: ImageKit private key
- **Get From**: ImageKit Dashboard > Developer Options
- **Example**: `private_xyz789uvw456rst123`

#### `PROFILE_DIR`
- **Type**: String
- **Default**: `FlipxerProfile`
- **Description**: Directory name for user profile images
- **Example**: `FlipxerProfile`

#### `DOCUMENT_DIR`
- **Type**: String
- **Default**: `FlipxerDocument`
- **Description**: Directory name for user documents (KYC)
- **Example**: `FlipxerDocument`

### Dojah (KYC/Identity Verification)

#### `DOJAH_BASE_URL` ⚠️
- **Type**: URL
- **Options**:
  - Sandbox: `https://sandbox.dojah.io/`
  - Production: `https://api.dojah.io/`
- **Description**: Dojah API base URL
- **Example**: `https://sandbox.dojah.io/`
- **Important**: Include trailing slash!

#### `DOJAH_APP_ID` ⚠️
- **Type**: String
- **Description**: Your Dojah application ID
- **Get From**: Dojah Dashboard
- **Example**: `67cae5830981f1257b9def92`

#### `DOJAH_PUBLIC_KEY` ⚠️
- **Type**: String
- **Description**: Dojah public API key
- **Get From**: Dojah Dashboard > API Keys
- **Example**: `prod_pk_xxxxxxxxxxxxxxxxx` (production) or `test_pk_xxxxxxxxxxxxxxxxx` (sandbox)

#### `DOJAH_SECRET_KEY` ⚠️
- **Type**: String
- **Description**: Dojah secret API key
- **Get From**: Dojah Dashboard > API Keys
- **Example**: `prod_sk_xxxxxxxxxxxxxxxxx` (production) or `test_sk_xxxxxxxxxxxxxxxxx` (sandbox)

#### `DOJAH_TOKEN_ID` ⚠️
- **Type**: String
- **Description**: Dojah token identifier
- **Get From**: Dojah Dashboard
- **Example**: `WFSurLbKYjtcycGE`

### Paystack (Payment Processing)

#### `PAYSTACK_BASE_URL`
- **Type**: URL
- **Default**: `https://api.paystack.co`
- **Description**: Paystack API base URL
- **Example**: `https://api.paystack.co`
- **Note**: Same for test and production

#### `PAYSTACK_SECRET_KEY` ⚠️
- **Type**: String
- **Description**: Paystack secret key
- **Get From**: Paystack Dashboard > Settings > API Keys & Webhooks
- **Example**: `sk_live_xxxxxxxxxxxxxxxxx` (production) or `sk_test_xxxxxxxxxxxxxxxxx` (test)
- **CRITICAL**: Never expose this key!

#### `PAYSTACK_CALLBACK_URL` ⚠️
- **Type**: URL
- **Description**: URL where users return after payment
- **Example**: `https://app.yourdomain.com?buy=success`
- **Development**: `http://localhost:3008?buy=success`

#### `PAYSTACK_CANCEL_ACTION` ⚠️
- **Type**: URL
- **Description**: URL where users return if payment is cancelled
- **Example**: `https://app.yourdomain.com/cancel`
- **Development**: `http://localhost:3008/cancel`

### Quidax (Cryptocurrency Trading)

#### `QUIDAX_BASE_URL`
- **Type**: URL
- **Default**: `https://app.quidax.io/api/v1`
- **Description**: Quidax API base URL
- **Example**: `https://app.quidax.io/api/v1`

#### `QUIDAX_RAMP_BASEURL`
- **Type**: URL
- **Default**: `https://ramp-be.quidax.io/api/v1/merchants`
- **Description**: Quidax Ramp API base URL
- **Example**: `https://ramp-be.quidax.io/api/v1/merchants`

#### `QUIDAX_API_PUBLIC` ⚠️
- **Type**: String
- **Description**: Quidax public API key
- **Get From**: Quidax Dashboard > API
- **Example**: `1Txjncmu3yRupvMi6BAqDdAm4DAcKLtCDWCwfHCF`

#### `QUIDAX_API_SECRET` ⚠️
- **Type**: String
- **Description**: Quidax secret API key
- **Get From**: Quidax Dashboard > API
- **Example**: `dxJc1G4Z1Ymb4Bxu73pBmItZwOC92O94bj0P55ev`

#### `QUIDAX_WEBHOOK_KEY` ⚠️
- **Type**: String
- **Description**: Secret key for verifying Quidax webhook signatures
- **Get From**: Quidax Dashboard > Webhooks
- **Example**: `your-webhook-secret-key`

---

## Email Configuration

### ZeptoMail Settings

#### `ZEPTOMAIL_URL`
- **Type**: String
- **Default**: `api.zeptomail.com/`
- **Description**: ZeptoMail API endpoint
- **Example**: `api.zeptomail.com/`
- **Important**: Include trailing slash!

#### `ZEPTOMAIL_TOKEN` ⚠️
- **Type**: String (Zoho encrypted API key format)
- **Description**: ZeptoMail API token for authentication
- **Get From**: ZeptoMail Dashboard > Account Settings > API Keys
- **Format**: `"Zoho-enczapikey YOUR_ENCRYPTED_API_KEY"`
- **Example**: `"Zoho-enczapikey wSsVR61/qBL0Wqd5ymL+dudsn1lcB1jxEhx4igTz63eu..."`
- **Important**: Include quotes and "Zoho-enczapikey" prefix!

#### `ZEPTOMAIL_SENDER` ⚠️
- **Type**: Email address
- **Description**: Default sender email address (must be verified in ZeptoMail)
- **Example**: `noreply@yourdomain.com`
- **Setup**: Verify domain in ZeptoMail Dashboard first!

### Email Template IDs

All template IDs below are obtained from ZeptoMail Dashboard > Templates:

#### `REGISTRATION_SUCCESS_TEMPLATE` ⚠️
- **Description**: Email sent after successful user registration
- **Example**: `2d6f.3cbe5afbd69d64c9.k1.4b8a76c0-20f4-11f0-b544-86f7e6aa0425.1966746a82c`

#### `VERIFY_ACCOUNT_TEMPLATE` ⚠️
- **Description**: Email sent for account verification
- **Example**: `2d6f.3cbe5afbd69d64c9.k1.c5e486d0-20f5-11f0-b544-86f7e6aa0425.196675057bd`

#### `FORGOT_PASSWORD_TEMPLATE` ⚠️
- **Description**: Email sent for password reset
- **Example**: `2d6f.3cbe5afbd69d64c9.k1.5d6ddc20-1a1d-11f0-b0c7-5254005934b4.1963a73c2e2`

#### `RECOVERY_PIN_TEMPLATE` ⚠️
- **Description**: Email sent with recovery PIN
- **Example**: `2d6f.3cbe5afbd69d64c9.k1.efc9f120-20f9-11f0-b544-86f7e6aa0425.196676ba132`

#### `TRANSACTION_NOTIFICATION_TEMPLATE` ⚠️
- **Description**: Email sent for successful transactions
- **Example**: `2d6f.3cbe5afbd69d64c9.k1.dd5513e0-6e1e-11f0-9c8d-525400d4bb1c.19860fe341e`

#### `FAILED_TRANSACTION_TEMPLATE` ⚠️
- **Description**: Email sent when transaction fails
- **Example**: `2d6f.3cbe5afbd69d64c9.k1.693e81a0-6eb7-11f0-9c8d-525400d4bb1c.19864e5eeba`

---

## Advanced Configuration

### Generating Secure Secrets

For production, ALWAYS generate new, unique secrets:

```bash
# Generate a 32-byte (64 character) hex secret
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Generate a 64-byte (128 character) hex secret
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"

# Generate a random base64 secret
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
```

### Environment-Specific Configurations

#### Development
```env
NODE_ENV=development
ENVIRONMENT=development
BASEURL=http://localhost:3500
ALLOWED_DOMAINS=http://localhost:3000,http://localhost:3008

# Use sandbox/test APIs
DOJAH_BASE_URL=https://sandbox.dojah.io/
PAYSTACK_SECRET_KEY=sk_test_...
```

#### Staging
```env
NODE_ENV=production
ENVIRONMENT=staging
BASEURL=https://api-staging.yourdomain.com
ALLOWED_DOMAINS=https://staging.yourdomain.com

# Use test APIs or production with test data
DOJAH_BASE_URL=https://sandbox.dojah.io/
PAYSTACK_SECRET_KEY=sk_test_...
```

#### Production
```env
NODE_ENV=production
ENVIRONMENT=production
BASEURL=https://api.yourdomain.com
ALLOWED_DOMAINS=https://app.yourdomain.com,https://www.yourdomain.com

# Use production APIs
DOJAH_BASE_URL=https://api.dojah.io/
PAYSTACK_SECRET_KEY=sk_live_...
```

### Seeded Account Passwords (development/testing)

- `SEED_DEFAULT_PASSWORD` (optional): Shared password for all seeded users (minimum 12 characters).
- `SEED_ADMIN_PASSWORD` (optional): Overrides admin seed password.
- `SEED_INDIVIDUAL_PASSWORD` (optional): Overrides John Doe seed password.
- `SEED_CHIDI_PASSWORD` (optional): Overrides Chidi Nwabeke seed password.
- `SEED_JANE_PASSWORD` (optional): Overrides Jane Smith seed password.
- `SEED_BUSINESS_PASSWORD` (optional): Overrides Acme Corp seed password.

If an env value is missing or too short, a random secure password is generated at seed time and logged once for reference. All passwords are stored hashed in the database.

---

## Validation Checklist

Before deploying, verify:

- [ ] All variables marked with ⚠️ are configured
- [ ] Production secrets are different from development
- [ ] Database URLs use `sslmode=require`
- [ ] CORS domains are specific (not wildcards)
- [ ] Email sender domain is verified in ZeptoMail
- [ ] All API keys are for production (not test/sandbox)
- [ ] Redis has authentication enabled
- [ ] `.env` is NOT committed to git
- [ ] Secrets are stored securely (e.g., vault, secrets manager)

---

## Troubleshooting

### "JWT malformed" errors
- Check `JWT_SECRET` and `JWT_REFRESH_SECRET` are set correctly
- Ensure secrets are at least 32 characters long

### Email not sending
- Verify `ZEPTOMAIL_SENDER` domain is verified in ZeptoMail
- Check `ZEPTOMAIL_TOKEN` includes `"Zoho-enczapikey "` prefix
- Verify template IDs exist in ZeptoMail dashboard

### CORS errors
- Ensure `ALLOWED_DOMAINS` includes your frontend URL
- No trailing slashes in domain URLs
- Check protocol matches (http vs https)

### Database connection errors
- Verify database credentials are correct
- Check `sslmode=require` is included
- Ensure database server allows connections from your IP

### Redis connection errors
- Verify Redis is running: `redis-cli ping`
- Check host, port, and password are correct
- Ensure Redis allows remote connections if not localhost

---

## Security Best Practices

1. **Never commit `.env`**: Already in `.gitignore`, but double-check!
2. **Rotate secrets regularly**: Change JWT secrets every 3-6 months
3. **Use environment-specific secrets**: Different values for dev/staging/prod
4. **Limit access**: Store production secrets in secret management system
5. **Audit access**: Regularly review who has access to secrets
6. **Monitor usage**: Set up alerts for unusual API usage

---

## Support

For questions or issues with environment configuration:
- Email: ibukunolaoluwa402@gmail.com
- Check: [DEPLOYMENT.md](./DEPLOYMENT.md) for deployment-specific help
