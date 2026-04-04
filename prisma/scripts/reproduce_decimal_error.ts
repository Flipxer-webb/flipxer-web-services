
import { Decimal } from "@prisma/client/runtime/library";

function toDecimal(value: any): Decimal {
    if (value instanceof Decimal) {
        return value;
    }
    return new Decimal(value);
}

console.log("Reproduction Script Start");

try {
    console.log("Testing undefined...");
    toDecimal(undefined);
} catch (e: any) {
    console.log("Caught:", e.toString());
}

try {
    console.log("Testing null...");
    toDecimal(null);
} catch (e: any) {
    console.log("Caught:", e.toString());
}
