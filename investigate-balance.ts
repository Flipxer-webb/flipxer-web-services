
import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

const prisma = new PrismaClient();

async function main() {
    const email = 'magpiep18@gmail.com';
    const currency = 'USDT';

    console.log(`Investigating for user: ${email}`);

    const user = await prisma.user.findUnique({
        where: { email },
    });

    if (!user) {
        console.log('User not found!');
        return;
    }

    // Get ALL history chronologically
    const history = await prisma.ledgerEntry.findMany({
        where: {
            userId: user.id,
            currency: currency
        },
        orderBy: { createdAt: 'asc' }
    });

    let output = `Investigating for user: ${email} (ID: ${user.id})\n`;
    output += `Currency: ${currency}\n`;
    output += `\n--- Full Ledger History (Chronological) ---\n`;

    let calculatedBalance = 0;

    history.forEach((e, index) => {
        const debit = Number(e.debit);
        const credit = Number(e.credit);
        const bal = Number(e.balanceAfter);

        calculatedBalance = calculatedBalance + credit - debit;

        const isMathCorrect = Math.abs(calculatedBalance - bal) < 0.0001;
        const diff = calculatedBalance - bal;

        output += `[${index}] ${e.createdAt.toISOString()} | ${e.type} (${e.status})\n`;
        output += `    Transaction: +${credit} / -${debit}\n`;
        output += `    System Bal:  ${bal}\n`;
        output += `    Calc Bal:    ${calculatedBalance} ${isMathCorrect ? '[OK]' : `[MISMATCH diff=${diff}]`}\n`;
        output += `    Ref:         ${e.reference}\n`;
        output += `    Desc:        ${e.description}\n`;
        output += `------------------------------------------------\n`;
    });

    const dumpPath = path.join(__dirname, 'ledger_full_dump.txt');
    fs.writeFileSync(dumpPath, output);
    console.log(`Dump written to ${dumpPath}`);
}

main()
    .catch(e => console.error(e))
    .finally(() => prisma.$disconnect());
