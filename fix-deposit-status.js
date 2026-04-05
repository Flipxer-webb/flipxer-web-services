const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  try {
    // Update the 3 RECEIVE orders to have accepted status and completed streamlined status
    const result = await prisma.order.updateMany({
      where: {
        userId: 6,
        orderCategory: 'RECEIVE',
        status: 'pending'
      },
      data: {
        status: 'accepted',
        streamlinedStatus: 'completed'
      }
    });
    
    console.log('Updated orders:', result.count);
    
    // Verify
    const orders = await prisma.order.findMany({
      where: { userId: 6, orderCategory: 'RECEIVE' }
    });
    
    console.log('\nUpdated RECEIVE orders:');
    orders.forEach(o => {
      console.log(`- ${o.amount} ${o.currency} | Status: ${o.status} | Streamlined: ${o.streamlinedStatus}`);
    });
    
  } catch (e) {
    console.error('Error:', e);
  } finally {
    await prisma.$disconnect();
  }
}

main();
