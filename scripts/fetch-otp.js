
const MailosaurClient = require('mailosaur');

// User provided credentials
const API_KEY = '2T3P8MubTunufE9iuFWOwiY37qO36QA6';
const SERVER_ID = 'yjo4y7so';
const TARGET_EMAIL = 'business_test_check_limits_prod_verify@yjo4y7so.mailosaur.net';

async function getLatestOtt() {
    const mailosaur = new MailosaurClient(API_KEY);

    // Look for emails received in the last 10 minutes to ensure freshness
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);

    console.log(`Searching for email sent to: ${TARGET_EMAIL} after ${tenMinutesAgo.toISOString()}...`);

    try {
        const email = await mailosaur.messages.get(SERVER_ID, {
            sentTo: TARGET_EMAIL,
            receivedAfter: tenMinutesAgo
        }, { timeout: 20000 });

        console.log(`Subject: ${email.subject}`);
        console.log(`Received: ${email.received}`);

        // Dump full body for inspection
        console.log('--- EMAIL BODY START ---');
        console.log(email.html.body);
        console.log('--- EMAIL BODY END ---');

    } catch (error) {
        console.error('Error fetching email:', error.message);
    }
}

getLatestOtt();
