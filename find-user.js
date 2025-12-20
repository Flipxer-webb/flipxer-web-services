const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

p.user.findMany({ 
    where: { email: { contains: 'temmy' } }, 
    select: { email: true, id: true, firstName: true } 
})
.then(users => {
    console.log('Users found:', users);
})
.finally(() => p.$disconnect());
