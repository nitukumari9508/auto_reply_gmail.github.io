
const fs = require('fs').promises;
const path = require('path');
const process = require('process');
const { authenticate } = require('@google-cloud/local-auth');
const { google } = require('googleapis');

// If modifying these scopes, delete token.json.
const SCOPES = ['https://www.googleapis.com/auth/gmail.modify'];
// The file token.json stores the user's access and refresh tokens, and is
// created automatically when the authorization flow completes for the first
// time.
const TOKEN_PATH = path.join(process.cwd(), 'token.json');
const CREDENTIALS_PATH = path.join(process.cwd(), 'credentials.json');


//Reads previously authorized credentials from the save file.
async function loadSavedCredentialsIfExist() {
    try {
        const content = await fs.readFile(TOKEN_PATH);
        const credentials = JSON.parse(content);
        return google.auth.fromJSON(credentials);
    } catch (err) {
        return null;
    }
}

//Serializes credentials to a file compatible with GoogleAUth.fromJSON.
async function saveCredentials(client) {
    const content = await fs.readFile(CREDENTIALS_PATH);
    const keys = JSON.parse(content);
    const key = keys.installed || keys.web;
    const payload = JSON.stringify({
        type: 'authorized_user',
        client_id: key.client_id,
        client_secret: key.client_secret,
        refresh_token: client.credentials.refresh_token,
    });
    await fs.writeFile(TOKEN_PATH, payload);
}

//Load or request or authorization to call APIs.
async function authorize() {
    let client = await loadSavedCredentialsIfExist();
    if (client) {
        return client;
    }
    client = await authenticate({
        scopes: SCOPES,
        keyfilePath: CREDENTIALS_PATH,
    });
    if (client.credentials) {
        await saveCredentials(client);
    }
    return client;
}


async function emailHandler() {
    try {
        console.log('Scanning for new emails...');

        const gmail = google.gmail({ version: 'v1', auth: await authorize() });

        const currentTime = new Date().getTime();
        const oneMinuteAgo = Math.floor((currentTime - 60000) / 1000);


        const response = await gmail.users.messages.list({
            userId: 'me',
            q: 'in:inbox is:unread category:primary after:' + oneMinuteAgo,
        });


        // console.log(response, "response")
        if (!response.data.messages) {
            console.log('No new emails');
            return;
        }
        const messages = response.data.messages;
        // console.log(messages, "messages")


        console.log(`Found ${messages.length} unread messages`);

        for (const message of messages) {
            const messageId = message.id;
            const threadId = message.threadId;


            const existingThread = await findThreadByMessageId(gmail, messageId);
            // console.log(existingThread, "existingThread");

            if (existingThread.messages.length > 1) {
                console.log(`Skipping email with message ID ${messageId}`);
                continue;
            }


            const latestEmailInThread = await getLatestEmailInThread(gmail, threadId);
            // console.log(latestEmailInThread, "latestEmailInThread");
            const to = latestEmailInThread.from;
            const subject = latestEmailInThread.subject

            console.log(latestEmailInThread.fromMe, "latestEmailInThread")
            const isReply = latestEmailInThread && latestEmailInThread.fromMe;
            if (!isReply) {
                console.log(`Replying to email with message ID ${messageId}`);

                const reply = await sendEmail(gmail, {
                    to,
                    subject,
                    body: 'thankyou revert as soon as possible.',
                    threadId,
                });

                console.log(`Replied to email with message ID ${messageId} with Reply ID ${reply.id}`);

                await addLabelToMessage(gmail, reply.id, 'Auto Reply');
            }
        }
    } catch (err) {
        console.error('Error occurred:', err);
    }
}

// Finds the thread containing the specified message ID.
async function findThreadByMessageId(gmail, messageId) {
    const response = await gmail.users.messages.get({
        userId: 'me',
        id: messageId,
        format: 'metadata',
        metadataHeaders: ['References', 'In-Reply-To'],
    });

    const threadId = response.data.threadId;

    const threadsResponse = await gmail.users.threads.get({
        userId: 'me',
        id: threadId,
        format: 'metadata',
        metadataHeaders: ['References', 'In-Reply-To'],
    });

    return threadsResponse.data;
}

//get the latest email in the thread
async function getLatestEmailInThread(gmail, threadId) {
    const response = await gmail.users.threads.get({
        userId: 'me',
        id: threadId,
    });

    const messages = response.data.messages;

    if (!messages || messages.length === 0) {
        return null;
    }

    const latestMessage = messages[messages.length - 1];
    console.log(latestMessage.payload.headers, "latestMessage")
    return {
        id: latestMessage.id,
        threadId,
        from: latestMessage.payload.headers.find(h => h.name === 'From').value,
        to: latestMessage.payload.headers.find(h => h.name === 'To').value,
        subject: latestMessage.payload.headers.find(h => h.name === 'Subject').value,
        date: new Date(parseInt(latestMessage.internalDate)),
        fromMe: latestMessage.labelIds.includes('SENT'),
    };
}

//Sends an email in reply to the specified message ID.
async function sendEmail(gmail, { to, subject, body, threadId }) {
    const message = [

        `From: kashyapnitu8271@gmail.com`,
        `To:${to}`,
        `Subject: ${subject}`,
        `In-Reply-To: ${threadId}`,
        `References: ${threadId}`,
        '',
        `${body}`
    ].join('\n').trim();

    const encodedMessage = Buffer.from(message).toString('base64');
    const res = await gmail.users.messages.send({
        userId: 'me',
        requestBody: {
            threadId,
            raw: encodedMessage,
        },
    });
    return res.data;
}

//Adds a label to the specified message ID.
async function addLabelToMessage(gmail, messageId, labelName) {
    // Retrieve the label object for the given label name
    const labelResponse = await gmail.users.labels.list({ userId: 'me' });
    const label = labelResponse.data.labels.find((l) => l.name === labelName);
    if (!label) {
        await gmail.users.labels.create({
            userId: 'me',
            requestBody: {
                name: labelName,
                labelListVisibility: 'labelShow',
                messageListVisibility: 'show',
                color: {
                    backgroundColor: '#ffffff',
                    textColor: '#000000',
                },
            },
        });
        console.log(`Created label ${labelName}`);
        addLabelToMessage(gmail, messageId, labelName)
    }


    // Add the label to the message
    const message = await gmail.users.messages.modify({
        userId: 'me',
        id: messageId,
        resource: {
            addLabelIds: [label.id],
        },
    });

    console.log(`Added label "${labelName}" to message with ID ${messageId}`);

    return message;
}

//Runs the script.
function run() {
    console.log('Starting script...');
    setInterval(emailHandler, 10000);
}

run();