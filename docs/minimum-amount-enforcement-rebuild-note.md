# Minimum Amount Enforcement Rebuild Note

Source behavior: old PR 334 branch work (`feat/minimum-trade-amounts`, `feat/minimum-trade-amounts-v2`).

## Behavior To Carry Forward

- Minimum buy: `3` USDT equivalent.
- Minimum sell: `3` USDT equivalent.
- Minimum swap: `10` USDT equivalent.
- Validation uses the source asset amount converted to USDT with current rates.
- `USDT` skips rate conversion and is validated directly.
- Swap validates the quote payload before the quote is burned, so invalid quotes are not consumed.

## Current File Mapping

- `src/modules/api/trade/constants/index.ts`
  - Replace the dormant `MIN_BUY_AMOUNT_USDT = 0` scaffold.
  - Add `MIN_SELL_AMOUNT_USDT` and `MIN_SWAP_AMOUNT_USDT`.

- `src/modules/api/trade/services/trade-helpers.service.ts`
  - Restore `RateService` dependency.
  - Restore async `validateMinimumAmountInUSDT(...)` with `buy | sell | swap` support.
  - Keep the `USDT` fast path and convert all other assets with current buy rates.

- `src/modules/api/trade/services/buy-order.service.ts`
  - Current insertion point: inside `buyCryptoOrder`, immediately after the idempotency replay guard and before the pending-order guard.
  - Call `await this.tradeHelpers.validateMinimumAmountInUSDT(dto.amount, dto.asset, MIN_BUY_AMOUNT_USDT, "buy")`.

- `src/modules/api/trade/services/sell-order.service.ts`
  - Reintroduce `TradeHelpersService` dependency.
  - Current insertion point: inside `sellCryptoOrder`, immediately after `calculateSellQuote(user, dto, true)` and before idempotency and hold logic.

- `src/modules/api/trade/services/swap.service.ts`
  - Reintroduce `TradeHelpersService` dependency and `MIN_SWAP_AMOUNT_USDT`.
  - Current insertion point: inside `confirmInstantSwapQuote`, load the quote first, validate `quote.from_amount` and `quote.from_currency`, then consume it with `getDel(...)` before continuing.
  - Do not keep the current burn-first flow for minimum validation.

- `src/modules/api/trade/services/__tests__/trade-helpers.service.spec.ts`
  - Add rate-backed conversion coverage for `USDT`, non-`USDT`, and operation-specific error messages.

- `src/modules/api/trade/services/__tests__/buy-order.service.spec.ts`
  - Assert minimum validation runs before pending-order lookup and payment initialization.

- `src/modules/api/trade/services/__tests__/sell-order.service.spec.ts`
  - Assert minimum validation runs before idempotency lookup and hold creation.

- `src/modules/api/trade/services/__tests__/swap.service.spec.ts`
  - Assert minimum validation runs before `getDel(...)`, so rejected swaps do not consume the quote.
