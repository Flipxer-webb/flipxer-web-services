
const MailosaurClient = require('mailosaur');

const API_KEY = '2T3P8MubTunufE9iuFWOwiY37qO36QA6';
const SERVER_ID = 'yjo4y7so';

async function listMessages() {
    const mailosaur = new MailosaurClient(API_KEY);
    try {
        const result = await mailosaur.messages.list(SERVER_ID);
        console.log(`Found ${result.items.length} messages.`);
        result.items.slice(0, 5).forEach(m => {
            console.log(`- To: ${m.to[0].email} | Subject: ${m.subject} | Received: ${m.received}`);
        });
    } catch (error) {
        console.error('Error listing messages:', error.message);
    }
}

listMessages();
