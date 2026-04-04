
const fs = require('fs');

try {
    // Try reading as UTF-16LE since PowerShell > redirects often use that
    let content;
    try {
        content = fs.readFileSync('email_dump.txt', 'utf16le');
    } catch (e) {
        // Fallback if utf16le fails or file not found
        content = fs.readFileSync('email_dump.txt', 'utf8');
    }

    // Refined regex: Look for 6 digits that are NOT surrounded by other numbers/letters/hex-like chars
    // and ideally inside the HTML structure we saw earlier, or just isolated.
    // The false positive '020202' suggests we matched something like #020202 (color).

    // Strategy 1: Look for digits inside the specific div
    const divMatch = content.match(/class="otp-code"[^>]*>\s*(\d{6})\s*</);

    // Strategy 2: Look for 6 digits that are NOT part of a hex color (preceded by #) or long number
    // Negative lookbehind for # is tricky in JS regex depending on version, so we check conventionally.
    const allMatches = [...content.matchAll(/(?<![\d#a-zA-Z])(\d{6})(?![\d#a-zA-Z])/g)];

    // Filter out obvious repeating patterns if any (heuristic) or known bad values
    const candidates = allMatches.map(m => m[1]).filter(code => code !== '020202' && code !== '000000');

    if (divMatch) {
        console.log('OTP FOUND (Structure Match):', divMatch[1]);
    } else if (candidates.length > 0) {
        // Return the LAST candidate as it's likely the most recent if multiple exist, 
        // or the one that stands out.
        console.log('OTP FOUND (Pattern Match):', candidates[candidates.length - 1]);
        console.log('All candidates:', candidates);
    } else {
        console.log('OTP not found. Dumping "otp-code" context:');
        const idx = content.indexOf('otp-code');
        if (idx !== -1) {
            console.log(content.substring(idx, idx + 200));
        } else {
            console.log('Could not find "otp-code" class.');
        }
    }
} catch (e) {
    console.error('Error reading file:', e.message);
}
