/**
 * Bot and Health Check Detection Utility
 * 
 * Detects automated traffic from health checks, load balancers, bots, and crawlers
 * to prevent them from being recorded as active user sessions.
 */

// Known AWS IP prefixes that are commonly used by health checks and bots
const AWS_IP_PREFIXES = [
    '3.',
    '13.',
    '16.',
    '18.',
    '34.',
    '35.',
    '44.',
    '52.',
    '54.',
    '99.',
];

// Known bot/crawler user agent patterns
const BOT_USER_AGENT_PATTERNS = [
    /bot/i,
    /crawler/i,
    /spider/i,
    /headless/i,
    /phantom/i,
    /puppeteer/i,
    /selenium/i,
    /curl/i,
    /wget/i,
    /axios/i,
    /node-fetch/i,
    /python-requests/i,
    /go-http-client/i,
    /java/i,
    /http client/i,
    /monitoring/i,
    /health/i,
    /uptime/i,
    /pingdom/i,
    /datadog/i,
    /newrelic/i,
    /cloudflare/i,
];

// Suspicious browser/OS combinations that indicate automated traffic
const SUSPICIOUS_COMBINATIONS = [
    { browser: 'safari', os: 'linux' }, // Safari doesn't run on Linux
    { browser: 'safari', os: 'armv81' },
    { browser: null, os: 'linux' },
];

export interface SessionInfo {
    browser?: string | null;
    os?: string | null;
    ipAddress?: string | null;
    deviceName?: string | null;
    userAgent?: string | null;
}

/**
 * Check if an IP address belongs to known cloud/AWS ranges
 */
export function isCloudProviderIP(ipAddress: string | null | undefined): boolean {
    if (!ipAddress) return false;
    return AWS_IP_PREFIXES.some((prefix) => ipAddress.startsWith(prefix));
}

/**
 * Check if user agent matches known bot patterns
 */
export function isBotUserAgent(userAgent: string | null | undefined): boolean {
    if (!userAgent) return false;
    return BOT_USER_AGENT_PATTERNS.some((pattern) => pattern.test(userAgent));
}

/**
 * Check if browser/OS combination is suspicious
 */
export function isSuspiciousCombination(
    browser: string | null | undefined,
    os: string | null | undefined
): boolean {
    if (!browser && !os) return true; // No device info is suspicious

    const browserLower = browser?.toLowerCase() || '';
    const osLower = os?.toLowerCase() || '';

    return SUSPICIOUS_COMBINATIONS.some((combo) => {
        const browserMatch = combo.browser === null || browserLower.includes(combo.browser);
        const osMatch = combo.os === null || osLower.includes(combo.os);
        return browserMatch && osMatch;
    });
}

/**
 * Comprehensive check to determine if a session is likely from a bot or health check
 */
export function isLikelyBotTraffic(sessionInfo: SessionInfo): boolean {
    // Check for cloud provider IP
    if (isCloudProviderIP(sessionInfo.ipAddress)) {
        // Cloud IP + suspicious combination = definitely a bot
        if (isSuspiciousCombination(sessionInfo.browser, sessionInfo.os)) {
            return true;
        }
    }

    // Check for bot user agent
    if (isBotUserAgent(sessionInfo.userAgent)) {
        return true;
    }

    // Check for suspicious browser/OS combo with cloud IP
    if (isCloudProviderIP(sessionInfo.ipAddress) && isSuspiciousCombination(sessionInfo.browser, sessionInfo.os)) {
        return true;
    }

    return false;
}

/**
 * Get reason why session is flagged as bot traffic (for logging)
 */
export function getBotTrafficReason(sessionInfo: SessionInfo): string | null {
    const reasons: string[] = [];

    if (isCloudProviderIP(sessionInfo.ipAddress)) {
        reasons.push(`Cloud/AWS IP: ${sessionInfo.ipAddress}`);
    }

    if (isBotUserAgent(sessionInfo.userAgent)) {
        reasons.push(`Bot user-agent detected`);
    }

    if (isSuspiciousCombination(sessionInfo.browser, sessionInfo.os)) {
        reasons.push(`Suspicious combo: ${sessionInfo.browser}/${sessionInfo.os}`);
    }

    return reasons.length > 0 ? reasons.join(', ') : null;
}
