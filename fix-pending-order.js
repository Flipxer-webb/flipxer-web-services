
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const transactionId = '7CBGCDFE8H70DG4';
  
  console.log(`Fixing transaction: ${transactionId}`);

  const order = await prisma.order.findFirst({
    where: { transactionId: transactionId }
  });

  if (!order) {
    console.log('Order not found');
    return;
  }

  if (order.status === 'accepted') {
    console.log('Order is already accepted');
    return;
  }

  console.log(`Current status: ${order.status}`);
  console.log('Updating to accepted/completed...');

  const updated = await prisma.order.update({
    where: { id: order.id },
    data: {
      status: 'accepted',
      streamlinedStatus: 'completed'
    }
  });

  console.log('Order updated:', updated);
}

main()
  .catch(e => console.error(e))
  .finally(async () => {
    await prisma.$disconnect();
  });
