# Two-Factor Authentication (2FA) Implementation Analysis

## Current Implementation Status ✅

### 1. **2FA Setup & Management** (Settings Module)
✅ **Implemented Features:**
- Setup 2FA (Generate QR code + secret)
- Enable 2FA (Verify TOTP code)
- Disable 2FA (Verify TOTP + password)
- Get 2FA Status
- Internal verification method for login

**Endpoints:**
- `POST /api/v1/settings/setup-2fa` - Generate QR code
- `POST /api/v1/settings/enable-2fa` - Activate 2FA
- `POST /api/v1/settings/disable-2fa` - Deactivate 2FA
- `GET /api/v1/settings/2fa-status` - Check if enabled

### 2. **2FA Login Flow** (Auth Module)
✅ **Implemented Features:**
- Login detects if 2FA is enabled
- Returns `tempToken` with 5-minute expiry
- `requiresTwoFactor: true` flag in response
- Separate endpoint to verify 2FA code and complete login
- Session creation after successful 2FA verification

**Endpoints:**
- `POST /api/v1/auth/login` - Initial login (returns tempToken if 2FA enabled)
- `POST /api/v1/auth/verify-2fa-login` - Complete login with TOTP code
- `POST /api/v1/auth/verify-biometric-2fa-login` - Biometric 2FA (Tier 3)

### 3. **2FA Transaction Protection** (Trade Module)
✅ **Implemented Features:**
- `TwoFactorGuard` - Protects transaction endpoints
- Applied to: Buy, Sell, Swap, Send operations
- Accepts code via:
  - Request body: `twoFactorCode`
  - Header: `x-2fa-code`
- Blocks transaction if 2FA not enabled
- Verifies TOTP code before allowing transaction

**Protected Endpoints:**
- `POST /api/v1/trade/buy` - @UseGuards(TwoFactorGuard)
- `POST /api/v1/trade/sell` - @UseGuards(TwoFactorGuard)
- `POST /api/v1/trade/swap` - @UseGuards(TwoFactorGuard)

---

## Issues & Improvements Needed ⚠️

### Issue 1: **Mandatory 2FA for Transactions** 🔴
**Problem:** 
Currently, `TwoFactorGuard` **requires** 2FA to be enabled for ALL transactions. Users without 2FA cannot trade.

**Error thrown:**
```typescript
throw new UserForbiddenException(
    "Two-factor authentication must be enabled to perform this action",
    HttpStatus.FORBIDDEN
);
```

**Impact:** Users are forced to enable 2FA, which may hurt user experience.

**Recommendation:** Make 2FA optional but recommended
- Allow transactions without 2FA
- Show warnings/prompts to enable 2FA
- Use a system setting to toggle enforcement

---

### Issue 2: **Admin Login Bypass** 🔐
**Current Code:**
```typescript
if (user.isTwoFactorEnabled && user.twoFactorSecret && loginPlatform === LoginPlatform.USER) {
    // 2FA check...
}
```

**Problem:** 
- Admin logins **bypass 2FA** completely
- Security risk for privileged accounts
- Admins need 2FA protection more than regular users

**Recommendation:** Enable 2FA for admin logins
```typescript
if (user.isTwoFactorEnabled && user.twoFactorSecret) {
    // Remove platform check
}
```

---

### Issue 3: **TwoFactorGuard Logic** 🛡️
**Current Implementation:**
```typescript
if (!userData?.isTwoFactorEnabled || !userData?.twoFactorSecret) {
    throw new UserForbiddenException(
        "Two-factor authentication must be enabled to perform this action",
        HttpStatus.FORBIDDEN
    );
}
```

**Problem:** 
- Blocks all users without 2FA
- Forces 2FA adoption
- No graceful degradation

**Recommendation:** 
```typescript
// Option A: Make 2FA optional
if (userData?.isTwoFactorEnabled && userData?.twoFactorSecret) {
    // Only verify if enabled
    const code = request.body?.twoFactorCode || request.headers["x-2fa-code"];
    if (!code) {
        throw new UserForbiddenException("2FA code required");
    }
    // Verify code...
}
return true; // Allow transaction without 2FA

// Option B: Make it configurable
const require2FA = await this.getSystemSetting('REQUIRE_2FA_FOR_TRANSACTIONS');
if (require2FA && !userData?.isTwoFactorEnabled) {
    throw new UserForbiddenException("2FA required by system policy");
}
```

---

### Issue 4: **Missing Transaction Amount Threshold** 💰
**Current:** 2FA is all-or-nothing

**Recommendation:** Implement amount-based 2FA
```typescript
const TRANSACTION_THRESHOLD = 100000; // NGN

if (transactionAmount >= TRANSACTION_THRESHOLD && userData?.isTwoFactorEnabled) {
    // Require 2FA only for large transactions
}
```

---

### Issue 5: **No Backup Codes** 🆘
**Problem:** 
- Users lose phone → locked out forever
- No recovery mechanism
- Support burden increases

**Recommendation:** Add backup codes
- Generate 10 single-use codes during setup
- Store hashed in database
- Display once to user
- Allow recovery with backup code

---

### Issue 6: **Limited Error Messages** 📝
**Current:**
```typescript
throw new UserForbiddenException("Invalid verification code", HttpStatus.FORBIDDEN);
```

**Problems:**
- No indication of attempts remaining
- No guidance on what went wrong
- Same error for expired codes vs wrong codes

**Recommendation:** Better error messages
```typescript
if (!isValid) {
    // Check if code is time-skewed
    const isValidWithWindow = authenticator.verify({
        token: code,
        secret: secret,
        window: 1 // Allow 1 step time difference
    });
    
    if (isValidWithWindow) {
        throw new Error("Code is valid but timing is off. Check your device time.");
    }
    
    throw new Error("Invalid code. Please try again with a fresh code from your app.");
}
```

---

### Issue 7: **No Rate Limiting on 2FA Verification** 🚨
**Problem:**
- Attackers can brute force 6-digit codes
- 1 million possible combinations (000000-999999)
- No protection against automated attacks

**Recommendation:** Add rate limiting
```typescript
// Track failed attempts in Redis
const attempts = await redis.incr(`2fa:attempts:${userId}`);
await redis.expire(`2fa:attempts:${userId}`, 300); // 5 minutes

if (attempts > 3) {
    throw new Error("Too many failed attempts. Try again in 5 minutes.");
}

if (!isValid) {
    // Increment stays
} else {
    await redis.del(`2fa:attempts:${userId}`); // Clear on success
}
```

---

### Issue 8: **Missing Notification System** 📧
**Problem:**
- No email when 2FA is enabled/disabled
- No alert when 2FA fails multiple times
- No notification of suspicious login attempts

**Recommendation:**
```typescript
// On 2FA enable
await this.emailService.send({
    to: user.email,
    subject: "Two-Factor Authentication Enabled",
    template: "2fa-enabled",
    data: { time: new Date(), ip, device }
});

// On 2FA disable
await this.emailService.send({
    to: user.email,
    subject: "Two-Factor Authentication Disabled",
    template: "2fa-disabled",
    data: { time: new Date(), ip }
});

// On multiple failed attempts
await this.emailService.send({
    to: user.email,
    subject: "Suspicious Activity Detected",
    template: "2fa-failed-attempts"
});
```

---

## Recommended Implementation Plan 🎯

### Phase 1: Critical Fixes (High Priority)
1. ✅ **Make 2FA optional for transactions** (not mandatory)
2. ✅ **Enable 2FA for admin logins**
3. ✅ **Add rate limiting** to prevent brute force
4. ✅ **Improve error messages** with helpful guidance

### Phase 2: Enhanced Security (Medium Priority)
5. ⏱️ **Add backup codes** for account recovery
6. ⏱️ **Implement transaction threshold** (2FA only for large amounts)
7. ⏱️ **Add email notifications** for 2FA events

### Phase 3: UX Improvements (Low Priority)
8. ⏱️ **Time window tolerance** for slightly wrong clocks
9. ⏱️ **Trusted devices** (remember device for 30 days)
10. ⏱️ **SMS backup option** for users without authenticator apps

---

## Current Architecture

```
┌─────────────────┐
│  USER SETUP     │
│  /settings      │
└────────┬────────┘
         │
         ├─> setup-2fa    (Generate QR code)
         ├─> enable-2fa   (Verify TOTP + activate)
         ├─> disable-2fa  (Verify TOTP + password)
         └─> 2fa-status   (Check if enabled)

┌─────────────────┐
│  LOGIN FLOW     │
│  /auth          │
└────────┬────────┘
         │
         ├─> POST /login
         │   ├─> 2FA disabled? → Return tokens
         │   └─> 2FA enabled? → Return tempToken
         │
         └─> POST /verify-2fa-login
             └─> Verify TOTP → Return tokens

┌─────────────────┐
│  TRANSACTIONS   │
│  /trade         │
└────────┬────────┘
         │
         └─> @UseGuards(TwoFactorGuard)
             ├─> Check if 2FA enabled
             ├─> Extract code from body/header
             └─> Verify TOTP code
```

---

## Code Locations

| Feature | File | Lines |
|---------|------|-------|
| 2FA Setup/Enable/Disable | `settings/services/index.ts` | 369-596 |
| 2FA Login Verification | `auth/services/index.ts` | 1192-1202, 1329-1450 |
| TwoFactorGuard | `auth/guard/index.ts` | 426-478 |
| 2FA DTOs | `settings/dtos/index.ts` | 96-157 |
| Login 2FA DTOs | `auth/dtos/index.ts` | 92-120 |

---

## Summary

The current 2FA implementation is **functional but has critical issues**:

✅ **Working:**
- Complete setup/enable/disable flow
- Login 2FA with temporary tokens
- Transaction protection guard
- TOTP verification

❌ **Issues:**
- Forces 2FA for all transactions (mandatory)
- Admin logins bypass 2FA (security risk)
- No rate limiting (brute force vulnerable)
- No backup codes (lockout risk)
- No email notifications
- Poor error messages

**Priority Action:** Make 2FA optional for transactions while keeping it available for users who want extra security.
