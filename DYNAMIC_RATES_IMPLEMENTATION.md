# Dynamic Rate Calculation System Implementation

**Started:** January 13, 2026  
**Status:** In Progress  
**Author:** AI Assistant + Admin  

---

## Overview

Replace manual 40+ asset rate management with automated calculation:

```
Asset/NGN = (Asset/USDT from Binance) × (USDT/NGN from admin)
```

Admin only manages **one rate (USDT/NGN)** with buy/sell spread.

---

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Price Source | Binance API | Native USDT pairs, no auth needed, industry standard |
| Fallback | LiveCoinWatch | Supports `currency: "USDT"` parameter |
| Cache TTL | 60 seconds | Balance freshness vs API limits |
| Rollback Strategy | Feature Flag + DB Override | Safe gradual rollout |
| Feature Flag Key | `feature:dynamic_rates` | Redis key, default OFF |

---

## Rate Calculation Formula

```typescript
// For BUY orders (user buying crypto, we sell):
assetSellRate = assetUsdtPrice × usdtRate.sellRate

// For SELL orders (user selling crypto, we buy):
assetBuyRate = assetUsdtPrice × usdtRate.buyRate

// Example with BTC at 45,000 USDT and USDT rates 1580/1620:
BTC Buy Rate  = 45000 × 1620 = 72,900,000 NGN
BTC Sell Rate = 45000 × 1580 = 71,100,000 NGN
```

---

## Implementation Progress

### Phase 1a: Create BinanceService ✅
- [x] Create `src/modules/factory/trading/providers/binance/services/index.ts`
- [x] Implement `getPriceInUSDT(asset: string): Promise<number>`
- [x] Implement `getBatchPricesInUSDT(assets: string[]): Promise<Map<string, number>>`
- [x] Add symbol mapping (MATIC→POL, etc.)
- [x] Handle stablecoins (USDC/USDT pair)
- [x] Add error handling and logging

### Phase 1b: Price Caching Scheduler ✅
- [x] Update `PriceCacheSchedulerService` to use Binance as primary
- [x] Cache X/USDT prices with 60s TTL
- [x] Fallback to LiveCoinWatch if Binance fails
- [x] Keep last cached rate on complete failure

### Phase 2a: Create RateService ✅
- [x] Create `src/modules/api/trade/services/rate.service.ts`
- [x] Implement `getAssetRate(currency: string): Promise<{buyRate, sellRate}>`
- [x] Implement `getAllRates(): Promise<AssetRate[]>`
- [x] Add USDT rate validation (alert if missing)
- [x] Implement feature flag check
- [x] Implement DB override logic

### Phase 2b: Add Feature Flag ✅
- [x] Add `feature:dynamic_rates` Redis key
- [x] Create admin toggle endpoint
- [x] Default to OFF (legacy mode)
- [x] Add logging when flag changes

### Phase 3: Update Buy/Sell Services ✅
- [x] Update `buy-order.service.ts`
- [x] Update `sell-order.service.ts`
- [x] Update `send.service.ts`
- [x] Verify `rateAtConversion` still stored correctly

### Phase 4: Update Swap Service ✅
- [x] Update `swap.service.ts`
- [x] Preserve `SwapPair` admin override logic
- [x] Update cross-rate calculation

### Phase 5: Update Wallet/Analytics ✅
- [x] Trading paths updated
- [x] Display-only lookups left as-is for performance (uses DB rates as fallback)

### Phase 6: Admin API Endpoints ✅
- [x] Add `GET /admin/settings/crypto/calculated-rates`
- [x] Add `GET /admin/settings/crypto/dynamic-rates/status`
- [x] Add `POST /admin/settings/crypto/dynamic-rates/toggle`
- [x] Add `POST /admin/settings/crypto/dynamic-rates/invalidate-cache`

### Phase 7: Frontend Admin UI ⏳
- [ ] Make USDT editing prominent
- [ ] Show read-only calculated rates for others
- [ ] Add feature flag toggle switch
- [ ] Add `lastUpdated` display

### Phase 8: Testing & Deployment ⏳
- [ ] Unit tests for BinanceService
- [ ] Unit tests for RateService
- [ ] Integration tests for buy/sell/swap
- [ ] Compare old vs new rate calculations
- [ ] Deploy with feature flag OFF
- [ ] Enable for test accounts first
- [ ] Gradual rollout to production

### Phase 9: Cleanup & Deprecation ⏳
- [ ] Monitor for 2-4 weeks
- [ ] Delete non-USDT CryptoRate entries
- [ ] Remove feature flag checks
- [ ] Remove legacy rate lookup code
- [ ] Simplify admin UI

---

## Files Created

| File | Purpose | Status |
|------|---------|--------|
| `providers/binance/services/index.ts` | Binance price fetching | ✅ |
| `trade/services/rate.service.ts` | Centralized rate calculation | ✅ |

## Files Modified

| File | Changes | Status |
|------|---------|--------|
| `buy-order.service.ts` | Use RateService | ✅ |
| `sell-order.service.ts` | Use RateService | ✅ |
| `send.service.ts` | Use RateService | ✅ |
| `swap.service.ts` | Use RateService | ✅ |
| `scheduler/services/coinGecko.ts` | Add USDT price cron | ✅ |
| `livecoinwatch/services/index.ts` | Add getPriceInUSDT | ✅ |
| `settings/controllers/v1/admin.ts` | Add dynamic rate endpoints | ✅ |
| Frontend `rates.tsx` | UI updates | ⏳ |

---

## Rollback Plan

### Level 1: Feature Flag
```bash
# Redis CLI
SET feature:dynamic_rates "false"
```
System immediately reverts to legacy `CryptoRates` table lookups.

### Level 2: DB Override
If specific asset needs manual rate:
1. Set `CryptoRates` entry with `buyRate > 0` and `sellRate > 0`
2. RateService will use DB value instead of calculated

### Level 3: Code Revert
Revert deployment if critical issues found.

---

## Edge Cases

| Case | Handling |
|------|----------|
| USDT rate missing | Block operations, send Slack alert to admin |
| USDT asset itself | Use DB rates directly (buyRate/sellRate) |
| USDC (stablecoin) | Fetch USDC/USDT rate from Binance (not assumed 1:1) |
| MATIC symbol | Map to POL (Polygon rebrand) |
| Binance down | Fallback to LiveCoinWatch, then last cached |
| Rate volatility | Store `rateAtConversion` per transaction |

---

## Monitoring & Alerts

- [ ] Add Slack alert for USDT rate missing
- [ ] Add Slack alert for Binance API failures
- [ ] Monitor rate calculation latency
- [ ] Log feature flag state changes
- [ ] Compare calculated vs legacy rates periodically

---

## Changelog

### January 13, 2026
- [x] Phase 1a completed - BinanceService created
- [x] Phase 1b completed - Price caching scheduler updated with 60s USDT cron
- [x] Phase 2a completed - RateService created with feature flag + DB override
- [x] Phase 2b completed - Feature flag implemented
- [x] Phase 3 completed - Buy/Sell/Send services updated
- [x] Phase 4 completed - Swap service updated
- [x] Phase 5 completed - Trading paths done (display-only unchanged)
- [x] Phase 6 completed - Admin API endpoints added
- [ ] Phase 7 pending - Frontend Admin UI
- [ ] Phase 8 pending - Testing & Deployment
- [ ] Phase 9 pending - Cleanup & Deprecation