# Dynamic Rate Calculation System

## Overview

This document describes the dynamic rate calculation system that automatically calculates crypto asset rates based on Binance prices and a single admin-managed USDT/NGN base rate.

## Architecture

### Formula
```
Asset/NGN = (Asset/USDT from Binance) × (USDT/NGN Base Rate)
```

- **BUY orders** (user buys crypto): Uses `usdtRate.sellRate`
- **SELL orders** (user sells crypto): Uses `usdtRate.buyRate`

### Components

#### 1. BinanceService
**Location:** `src/modules/factory/trading/providers/binance/services/index.ts`

Fetches real-time crypto prices in USDT from Binance API.

```typescript
// Single price
const price = await binanceService.getPriceInUSDT('BTC');

// Batch prices
const prices = await binanceService.getBatchPricesInUSDT(['BTC', 'ETH', 'SOL']);
```

**Features:**
- Symbol mapping (MATIC → POL for Binance compatibility)
- Stablecoin handling (USDT, USDC return 1.0)
- No API key required (public endpoint)

#### 2. RateService
**Location:** `src/modules/api/trade/services/rate.service.ts`

Centralized rate calculation with feature flag support.

```typescript
// Get rate for trading
const rate = await rateService.getRateForCurrency('BTC', 'BUY');

// Check if dynamic mode is enabled
const enabled = await rateService.isDynamicRatesEnabled();

// Get all calculated rates (for admin display)
const rates = await rateService.getAllCalculatedRates();
```

**Features:**
- Feature flag checking
- DB override fallback (per-asset)
- USDT base rate validation
- Caching via Redis

#### 3. Price Caching Scheduler
**Location:** `src/modules/scheduler/services/coinGecko.ts`

60-second cron job that pre-fetches USDT prices for all supported assets.

```typescript
@Cron(CronExpression.EVERY_MINUTE)
async cacheUsdtPrices()
```

**Cache Keys:**
- `price:usdt:{SYMBOL}` - Individual asset USDT prices (60s TTL)
- `feature:dynamic_rates` - Feature flag

## Feature Flag

### Redis Key
```
feature:dynamic_rates
```

### Behavior
| Value | Mode |
|-------|------|
| `null` / `undefined` / `"true"` | Dynamic ON (default) |
| `"false"` | Legacy manual mode |

### Toggle via API
```bash
# Enable dynamic rates
POST /admin/settings/crypto/dynamic-rates/toggle
{ "enabled": true }

# Disable dynamic rates
POST /admin/settings/crypto/dynamic-rates/toggle
{ "enabled": false }
```

## Admin API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/admin/settings/crypto/calculated-rates` | GET | Returns all rates with dynamic metadata |
| `/admin/settings/crypto/dynamic-rates/status` | GET | Feature flag status and cache info |
| `/admin/settings/crypto/dynamic-rates/toggle` | POST | Enable/disable dynamic rates |
| `/admin/settings/crypto/dynamic-rates/invalidate-cache` | POST | Clear USDT price cache |

### Response Examples

**GET /calculated-rates**
```json
[
  {
    "currency": "BTC",
    "buyRate": 145000000,
    "sellRate": 144500000,
    "isDynamic": true,
    "usdtPrice": 97250.50,
    "lastUpdated": "2026-01-13T10:30:00Z"
  }
]
```

**GET /dynamic-rates/status**
```json
{
  "enabled": true,
  "usdtCacheTTL": 60,
  "lastUsdtPriceUpdate": "2026-01-13T10:30:00Z"
}
```

## Database Schema

### CryptoRate Table (Existing)
```prisma
model CryptoRate {
  id        Int      @id @default(autoincrement())
  currency  String   @unique
  buyRate   Float    @default(0)
  sellRate  Float    @default(0)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}
```

**After Migration:**
- Only `USDT` entry is required for dynamic mode
- Other entries serve as fallback/override when dynamic fails

## Trading Service Integration

### Updated Services
- `buy-order.service.ts` - Uses `RateService.getRateForCurrency(currency, 'BUY')`
- `sell-order.service.ts` - Uses `RateService.getRateForCurrency(currency, 'SELL')`
- `send.service.ts` - Uses `RateService.getRateForCurrency(currency, 'SEND')`
- `swap.service.ts` - Uses `RateService` with SwapPair override preservation

### Rate Selection Priority
1. **SwapPair override** (swap only) - Admin-set swap rates
2. **Dynamic calculation** (if enabled) - Binance × USDT base
3. **DB fallback** - CryptoRate table entry

## Frontend Admin UI

### Components
- `Rates.tsx` - Main container with dynamic/manual mode switching
- `DynamicRatesControl.tsx` - Toggle switch and status panel
- `BuyRates.tsx` / `SellRates.tsx` - Editable rate inputs

### UI Features
- USDT base rate highlighted and always editable
- Toggle switch for dynamic/manual mode
- Read-only calculated rates display (dynamic mode)
- Refresh button to invalidate cache
- Last updated timestamps

## Rollback Plan

### Disable Dynamic Rates
```bash
POST /admin/settings/crypto/dynamic-rates/toggle
{ "enabled": false }
```

This immediately reverts to legacy manual rate management.

### Full Rollback (Code)
1. Revert RateService changes in trading services
2. Restore direct `prisma.cryptoRate.findUnique()` calls
3. Remove BinanceService and scheduler cron

## Monitoring

### Key Metrics to Watch
- Binance API response times
- Cache hit/miss ratio
- Rate calculation failures
- USDT base rate staleness

### Logging
All rate calculations log:
- Currency requested
- Calculation method (dynamic/fallback)
- USDT price used
- Final rate returned

## Future Deprecation

### Phase 1 (Current)
- Dynamic rates default ON
- Manual rates as fallback
- Both modes available

### Phase 2 (Future)
- Remove manual rate editing for non-USDT assets
- Simplify CryptoRate table
- Archive historical manual rates

### Phase 3 (Final)
- Remove feature flag
- Remove fallback paths
- Fully automated rate system

## Troubleshooting

### Rates Not Updating
1. Check Binance API availability
2. Verify scheduler is running (`EVERY_MINUTE` cron)
3. Check Redis cache keys
4. Verify USDT base rate exists in DB

### Wrong Rates Displayed
1. Check feature flag status
2. Verify USDT/NGN base rate is correct
3. Check for DB overrides
4. Invalidate cache and refresh

### Fallback to Manual Mode
1. Toggle feature flag OFF
2. Update CryptoRate table entries manually
3. Investigate root cause
4. Re-enable when fixed
