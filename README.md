# Flipxer Web Services

> Core API service powering the Flipxer web application - a comprehensive financial services platform for cryptocurrency trading, payments, and identity verification.

[![Node.js](https://img.shields.io/badge/Node.js-18.18.2-green.svg)](https://nodejs.org/)
[![NestJS](https://img.shields.io/badge/NestJS-10.3-red.svg)](https://nestjs.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-4.3-blue.svg)](https://www.typescriptlang.org/)
[![Prisma](https://img.shields.io/badge/Prisma-4.13-purple.svg)](https://www.prisma.io/)

## 📋 Table of Contents

-   [Features](#features)
-   [Architecture](#architecture)
-   [Prerequisites](#prerequisites)
-   [Quick Start](#quick-start)
-   [Documentation](#documentation)
-   [API Endpoints](#api-endpoints)
-   [Development](#development)
-   [Testing](#testing)
-   [Deployment](#deployment)
-   [Contributing](#contributing)
-   [License](#license)

## ✨ Features

-   **User Authentication & Authorization**: JWT-based auth with role-based access control (RBAC)
-   **KYC/Identity Verification**: Integration with Dojah for compliance
-   **Payment Processing**: Paystack integration for deposits and withdrawals
-   **Cryptocurrency Trading**: Quidax integration for crypto buy/sell operations
-   **Real-time Updates**: WebSocket support for live trading data
-   **Background Jobs**: Bull queue for async task processing
-   **Caching**: Redis-based caching for optimal performance
-   **Email Notifications**: ZeptoMail integration with templating
-   **File Uploads**: Cloudinary/ImageKit for image storage
-   **API Documentation**: Auto-generated Swagger/OpenAPI docs
-   **Geolocation & Compliance**: Country blocking, IP tracking

## 🏗️ Architecture

This application is built using:

-   **Framework**: NestJS (Node.js framework)
-   **Language**: TypeScript
-   **Database**: PostgreSQL with Prisma ORM
-   **Cache**: Redis (via ioredis)
-   **Queue**: Bull (Redis-based job queue)
-   **Authentication**: JWT (JSON Web Tokens)
-   **Validation**: class-validator & class-transformer
-   **API Docs**: Swagger/OpenAPI

### Project Structure

```
flipxer-web-services/
├── src/
│   ├── config/          # Configuration files
│   ├── core/            # Core functionality (exceptions, pipes, decorators)
│   ├── libs/            # Third-party service wrappers (Dojah, Paystack, Quidax)
│   ├── modules/
│   │   ├── api/         # API endpoints (auth, user, trade, etc.)
│   │   ├── core/        # Core services (email, Redis, Prisma, messages)
│   │   ├── factory/     # Service factories (bank, trading, compliance)
│   │   ├── scheduler/   # Cron jobs and scheduled tasks
│   │   └── webhook/     # Webhook handlers (Paystack, Quidax)
│   ├── utils/           # Utility functions
│   ├── www/             # Server initialization
│   └── main.ts          # Application entry point
├── prisma/
│   ├── schema.prisma    # Database schema
│   └── migrations/      # Database migrations
├── dist/                # Compiled output
└── public/              # Static files
```

## 📦 Prerequisites

Before you begin, ensure you have the following installed:

-   **Node.js**: v18.18.2 ([Download](https://nodejs.org/))
-   **pnpm**: Package manager ([Installation](https://pnpm.io/installation))
-   **PostgreSQL**: v13+ ([Download](https://www.postgresql.org/download/))
-   **Redis**: v6+ ([Download](https://redis.io/download))

### Required Third-Party Accounts

-   [Cloudinary](https://cloudinary.com/) or [ImageKit](https://imagekit.io/) - Image storage
-   [Dojah](https://dojah.io/) - Identity verification
-   [Paystack](https://paystack.com/) - Payment processing
-   [Quidax](https://quidax.com/) - Cryptocurrency trading
-   [ZeptoMail](https://www.zoho.com/zeptomail/) - Transactional email

## 🚀 Quick Start

### 1. Clone the Repository

```bash
git clone https://github.com/OmeriHQ/flipxer-web-services.git
cd flipxer-web-services
```

### 2. Install Dependencies

```bash
# Install pnpm globally if not already installed
npm install -g pnpm

# Install project dependencies
pnpm install

# Set up Git hooks
pnpm run husky:install
```

### 3. Configure Environment Variables

```bash
# Copy the example environment file
cp .env.example .env

# Edit .env with your actual credentials
nano .env  # or use your preferred editor
```

See [ENVIRONMENT_VARIABLES.md](./ENVIRONMENT_VARIABLES.md) for detailed configuration guide.

### 4. Set Up Database

```bash
# Generate Prisma Client
pnpm prisma:generate

# Run database migrations
pnpm db:migrate:dev

# (Optional) Seed database with initial data
pnpm db:seed
```

### 5. Start the Application

```bash
# Development mode with hot-reload
pnpm run start:dev

# Production mode
pnpm run start:prod
```

The API will be available at `http://localhost:3500`

## 📚 Documentation

Comprehensive documentation is available:

-   **[DEPLOYMENT.md](./DEPLOYMENT.md)** - Complete deployment guide for production
-   **[ENVIRONMENT_VARIABLES.md](./ENVIRONMENT_VARIABLES.md)** - All environment variables explained
-   **[SECURITY.md](./SECURITY.md)** - Security best practices and guidelines
-   **[API_DOCUMENTATION.md](./API_DOCUMENTATION.md)** - API usage examples and guides
-   **[TECHNICAL_DEBT.md](./TECHNICAL_DEBT.md)** - Known issues and planned improvements

## 🔌 API Endpoints

### Interactive API Documentation

Once the server is running, visit:

-   **Swagger UI**: [http://localhost:3500/api](http://localhost:3500/api)

### Main Endpoint Categories

-   `/api/v1/auth` - Authentication (login, register, token refresh)
-   `/api/v1/users` - User management
-   `/api/v1/trade` - Cryptocurrency trading
-   `/api/v1/transactions` - Transaction history
-   `/api/v1/banks` - Bank account management
-   `/api/v1/settings` - User settings and preferences
-   `/api/v1/notifications` - User notifications
-   `/webhook/paystack` - Paystack webhook handler
-   `/webhook/quidax` - Quidax webhook handler

## 🛠️ Development

### Available Scripts

```bash
# Development
pnpm run start:dev          # Start with hot-reload
pnpm run start:debug        # Start in debug mode
pnpm run watch              # Watch mode with webpack

# Building
pnpm run build              # Build for production
pnpm run prebuild           # Clean dist folder

# Code Quality
pnpm run format             # Format code with Prettier
pnpm run lint               # Lint and fix code with ESLint

# Database
pnpm prisma:generate        # Generate Prisma Client
pnpm db:migrate:dev         # Run migrations (development)
pnpm db:migrate:prod        # Run migrations (production)
pnpm db:push                # Push schema changes
pnpm db:seed                # Seed database
pnpm db:studio              # Open Prisma Studio
pnpm migration:generate     # Create new migration
```

### Database Migrations

```bash
# Create a new migration
pnpm run migration:generate my_migration_name

# Apply migrations
pnpm run db:migrate:dev

# View/edit data
pnpm run db:studio
```

### Code Style

This project uses:

-   **ESLint** for linting
-   **Prettier** for code formatting
-   **Husky** for Git hooks
-   **lint-staged** for pre-commit checks

Code is automatically linted and formatted before commits.

## 🧪 Testing

```bash
# Run unit tests
pnpm test

# Run e2e tests
pnpm test:e2e

# Generate test coverage report
pnpm test:cov
```

**Note**: Test suite is currently being developed. See [TECHNICAL_DEBT.md](./TECHNICAL_DEBT.md) for details.

## 🚢 Deployment

### Quick Deploy

See [DEPLOYMENT.md](./DEPLOYMENT.md) for comprehensive deployment instructions.

### Docker Deployment

```bash
# Build Docker image
docker build -t flipxer-web-services:latest .

# Run with Docker Compose
docker-compose up -d
```

### Environment Variables

**CRITICAL**: Before deploying to production:

1. Generate new secure secrets (see [ENVIRONMENT_VARIABLES.md](./ENVIRONMENT_VARIABLES.md))
2. Rotate all API keys from development values
3. Update database URLs to production instances
4. Configure CORS for production domains
5. Enable SSL/TLS for database connections

## 🔒 Security

### Important Security Notes

-   **Never commit `.env` files** to version control
-   **Rotate secrets regularly** (every 3-6 months minimum)
-   **Use strong passwords** for all services (min 32 characters)
-   **Enable SSL/TLS** for all database and Redis connections
-   **Implement rate limiting** in production (see [SECURITY.md](./SECURITY.md))
-   **Set up monitoring** for suspicious activity

See [SECURITY.md](./SECURITY.md) for comprehensive security guidelines.

## 🤝 Contributing

Contributions are welcome! Please follow these steps:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

### Commit Convention

This project uses [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add new trading feature
fix: resolve authentication bug
docs: update deployment guide
refactor: improve error handling
test: add user service tests
```

## 📞 Support

For questions, issues, or support:

-   **Email**: adegbesan86@gmail.com
-   **Issues**: [GitHub Issues](https://github.com/OmeriHQ/flipxer-web-services/issues)

## 👥 Contributors

-   **Oluwatobi Adegbesan** - _Lead Developer_ - [Email](mailto:adegbesan86@gmail.com)
-   **Olaoluwa IBUKUN** - _Developer_ - [Email](mailto:ibukunolaoluwa402@gmail.com)
-   **Nwabekeyi Chidiebere** - _Developer_ - [Email](mailto:chidiebere@gmail.com)

## 📄 License

This project is licensed under the MIT License - see the LICENSE file for details.

## 🏦 About Flipxer

Flipxer is a comprehensive financial services platform that enables users to:

-   Trade cryptocurrencies securely
-   Process payments and transfers
-   Verify identity (KYC) for compliance
-   Manage digital wallets
-   Access real-time market data

---

**Built with ❤️ by the Whiteboard Team**

For production deployment, please review:

1. [DEPLOYMENT.md](./DEPLOYMENT.md) - Deployment instructions
2. [SECURITY.md](./SECURITY.md) - Security checklist
3. [ENVIRONMENT_VARIABLES.md](./ENVIRONMENT_VARIABLES.md) - Configuration guide
