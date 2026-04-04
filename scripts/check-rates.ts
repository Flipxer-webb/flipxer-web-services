import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

async function main() {
    const rates = await p.cryptoRate.findMany();
    console.log("CryptoRates:");
    for (const r of rates) {
        console.log(`  ${r.currency}: buyRate=${r.buyRate}, sellRate=${r.sellRate}`);
    }
    await p.$disconnect();
}

main();
