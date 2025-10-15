# Deployment Guide - Resolve Web Services

## Table of Contents
- [Prerequisites](#prerequisites)
- [Initial Setup](#initial-setup)
- [Environment Configuration](#environment-configuration)
- [Database Setup](#database-setup)
- [Deployment Options](#deployment-options)
- [Post-Deployment](#post-deployment)
- [Troubleshooting](#troubleshooting)

---

## Prerequisites

Before deploying, ensure you have:

- **Node.js**: v18.18.2 (specified in package.json)
- **pnpm**: Installed globally (`npm install -g pnpm`)
- **PostgreSQL**: v13+ database instance
- **Redis**: v6+ for caching and job queues
- **Docker** (optional, for containerized deployment)

### Required Third-Party Services

You'll need accounts and API credentials for:

1. **Cloudinary** or **ImageKit** - Image storage/delivery
2. **Dojah** - Identity verification (KYC)
3. **Paystack** - Payment processing
4. **Quidax** - Cryptocurrency trading
5. **ZeptoMail** - Email service
6. **PostgreSQL Database** - Can use Render, Neon, AWS RDS, etc.
7. **Redis Instance** - Can use Render, Redis Cloud, AWS ElastiCache, etc.

---

## Initial Setup

### 1. Clone and Install Dependencies

```bash
# Clone the repository
git clone https://github.com/OmeriHQ/resolve-web-services.git
cd resolve-web-services

# Install dependencies
pnpm install

# Install Husky for git hooks
pnpm run husky:install
```

### 2. Set Up Environment Variables

```bash
# Copy the example environment file
cp .env.example .env

# Edit .env with your actual credentials
nano .env  # or use your preferred editor
```

See [ENVIRONMENT_VARIABLES.md](./ENVIRONMENT_VARIABLES.md) for detailed configuration.

---

## Environment Configuration

### Critical Environment Variables

#### Security (Generate Strong Secrets!)

```bash
# Generate secure random secrets using Node.js
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Set these in your `.env`:
```env
JWT_SECRET=<generated-secret-64-chars>
JWT_REFRESH_SECRET=<generated-secret-64-chars>
ENCRYPT_SECRET=<generated-secret-64-chars>
```

#### Application Mode

```env
NODE_ENV=production
ENVIRONMENT=production
PORT=3500
BASEURL=https://your-api-domain.com
```

#### CORS Configuration

```env
ALLOWED_DOMAINS=https://your-frontend.com,https://www.your-frontend.com
FRONTEND_DEV_DOMAIN=https://your-frontend.com
```

---

## Database Setup

### 1. Create PostgreSQL Databases

You need TWO databases:
- **Main database**: For production data
- **Shadow database**: For Prisma migrations

```sql
-- Example SQL commands
CREATE DATABASE resolve_production;
CREATE DATABASE resolve_shadow_production;
```

### 2. Configure Database URLs

In `.env`:
```env
DATABASE_URL="postgresql://user:password@host:5432/resolve_production?sslmode=require"
SHADOW_DATABASE_URL="postgresql://user:password@host:5432/resolve_shadow_production?sslmode=require"
```

### 3. Run Migrations

```bash
# Generate Prisma Client
pnpm prisma:generate

# Run all migrations
pnpm db:migrate:prod

# Optional: Seed initial data
pnpm db:seed
```

### 4. Verify Database Connection

```bash
# Open Prisma Studio to verify
pnpm db:studio
```

---

## Deployment Options

### Option 1: Traditional Server Deployment (VPS/Cloud VM)

#### Step 1: Set Up Server

```bash
# SSH into your server
ssh user@your-server-ip

# Install Node.js 18.18.2
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install pnpm
npm install -g pnpm

# Install PM2 for process management
npm install -g pm2
```

#### Step 2: Deploy Application

```bash
# Clone repository
git clone https://github.com/OmeriHQ/resolve-web-services.git
cd resolve-web-services

# Install dependencies
pnpm install

# Set up environment variables
nano .env  # Add your production values

# Generate Prisma client
pnpm prisma:generate

# Run migrations
pnpm db:migrate:prod

# Build the application
pnpm build

# Start with PM2
pm2 start dist/server.js --name "resolve-api"
pm2 save
pm2 startup
```

#### Step 3: Configure Nginx (Reverse Proxy)

```nginx
# /etc/nginx/sites-available/resolve-api
server {
    listen 80;
    server_name api.yourdomain.com;

    location / {
        proxy_pass http://localhost:3500;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

```bash
# Enable site
sudo ln -s /etc/nginx/sites-available/resolve-api /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx

# Set up SSL with Let's Encrypt
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d api.yourdomain.com
```

---

### Option 2: Docker Deployment

#### Step 1: Build Docker Image

```bash
# Build the image
docker build -t resolve-web-services:latest .

# Test locally
docker run -p 3500:3500 --env-file .env resolve-web-services:latest
```

#### Step 2: Deploy with Docker Compose

Create `docker-compose.prod.yml`:

```yaml
version: '3.8'

services:
  api:
    image: resolve-web-services:latest
    ports:
      - "3500:3500"
    environment:
      - NODE_ENV=production
    env_file:
      - .env
    restart: unless-stopped
    depends_on:
      - redis
    networks:
      - resolve-network

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    volumes:
      - redis-data:/data
    networks:
      - resolve-network

volumes:
  redis-data:

networks:
  resolve-network:
    driver: bridge
```

Deploy:
```bash
docker-compose -f docker-compose.prod.yml up -d
```

---

### Option 3: Platform-as-a-Service (Render, Railway, Heroku)

#### Render Deployment

1. Create `render.yaml`:

```yaml
services:
  - type: web
    name: resolve-api
    env: node
    buildCommand: pnpm install && pnpm build
    startCommand: node dist/server.js
    envVars:
      - key: NODE_ENV
        value: production
      - key: DATABASE_URL
        fromDatabase:
          name: resolve-db
          property: connectionString
```

2. Push to GitHub and connect to Render
3. Set environment variables in Render dashboard
4. Deploy!

---

## Post-Deployment

### 1. Health Check

```bash
# Test API is running
curl https://api.yourdomain.com/api

# Check Swagger docs
open https://api.yourdomain.com/api
```

### 2. Monitor Logs

```bash
# PM2 logs
pm2 logs resolve-api

# Docker logs
docker-compose logs -f api

# Check for errors
pm2 monit
```

### 3. Set Up Monitoring

Consider integrating:
- **Sentry** for error tracking
- **New Relic** or **DataDog** for APM
- **LogRocket** for user session replay
- **UptimeRobot** for uptime monitoring

### 4. Database Backups

```bash
# Set up daily PostgreSQL backups
0 2 * * * pg_dump -U username -h host -d resolve_production > /backups/resolve_$(date +\%Y\%m\%d).sql
```

### 5. SSL Certificate Renewal

If using Let's Encrypt:
```bash
# Auto-renewal is usually set up, verify with:
sudo certbot renew --dry-run
```

---

## Troubleshooting

### Application Won't Start

1. **Check environment variables**: Ensure all required variables are set
   ```bash
   node -e "require('dotenv').config(); console.log(process.env.DATABASE_URL)"
   ```

2. **Check database connection**:
   ```bash
   pnpm prisma:generate
   pnpm db:studio
   ```

3. **Check Redis connection**: Ensure Redis is running and accessible

4. **Review logs**:
   ```bash
   pm2 logs resolve-api --lines 100
   ```

### Build Failures

```bash
# Clear cache and rebuild
rm -rf dist node_modules
pnpm install
pnpm build
```

### Database Migration Issues

```bash
# Reset and reapply migrations (CAUTION: Data loss!)
pnpm db:push

# Or manually fix migrations
pnpm migration:generate fix_issue
# Edit the generated migration
pnpm db:migrate:prod
```

### Port Already in Use

```bash
# Find process using port 3500
lsof -i :3500
# Kill it
kill -9 <PID>
```

### Memory Issues

```bash
# Increase Node.js memory limit
NODE_OPTIONS=--max-old-space-size=4096 pnpm start:prod
```

---

## Rollback Procedure

If deployment fails:

```bash
# Using PM2
pm2 stop resolve-api
git checkout <previous-commit>
pnpm install
pnpm build
pm2 restart resolve-api

# Using Docker
docker-compose down
docker pull resolve-web-services:previous-tag
docker-compose up -d
```

---

## Security Checklist

Before going live:

- [ ] All environment variables use strong, unique secrets
- [ ] Database connections use SSL (`sslmode=require`)
- [ ] Redis has authentication enabled
- [ ] Firewall rules restrict access to databases
- [ ] CORS is configured with specific domains (no wildcards)
- [ ] Rate limiting is enabled
- [ ] API keys are rotated from development values
- [ ] Monitoring and alerting are configured
- [ ] Database backups are automated
- [ ] SSL certificates are installed and auto-renewing

---

## Support

For issues or questions:
- Check [ENVIRONMENT_VARIABLES.md](./ENVIRONMENT_VARIABLES.md)
- Review [SECURITY.md](./SECURITY.md)
- Contact: adegbesan86@gmail.com
