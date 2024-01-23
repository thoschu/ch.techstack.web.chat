'use strict';

require('dotenv').config();

const fs = require('fs');
const https = require('https');
const axios = require('axios');
const express = require('express');
const { createServer} = require('node:http');
const { join} = require('node:path');
const { Server } = require('socket.io');
const { OpenAI } = require('openai');
const { createTransport } = require('nodemailer');
const { from, first, of, map} = require('rxjs');
const { head } = require('ramda');
const { v4: uuidv4 } = require('uuid');
const winston = require('winston');
//const { WebSocketServer, WebSocket } = require('ws');
//
//const wss = new WebSocketServer({ port: 3030 });
//
// wss.on('connection',  (ws) => {
//     console.log('connection');
//
//     ws.on('message', (data, isBinary) => {
//         console.dir(data);
//
//         // A client WebSocket broadcasting to all connected WebSocket clients, including itself.
//         // wss.clients.forEach((client) => {
//         //     if (client.readyState === WebSocket.OPEN) {
//         //         client.send(data, { binary: isBinary });
//         //     }
//         // });
//
//         // A client WebSocket broadcasting to every other connected WebSocket clients, excluding itself.
//         wss.clients.forEach((client) => {
//             if (client !== ws && client.readyState === WebSocket.OPEN) {
//                 client.send(data, { binary: isBinary });
//             }
//         });
//     });
//
//     ws.on('error', console.error);
// });

// ICU
// const number = 123456.789;
// console.log(new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(number));
// console.log(new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(number));
// console.log( ['thomas', 'äpfel', 'Müller', 'Zebra'].sort(new Intl.Collator('de-DE').compare));
// console.log(new Intl.DateTimeFormat('en-GB', {dateStyle: 'full', timeStyle: 'long', timeZone: 'Australia/Sydney',}).format(new Date()));

const env = process.env;
const systemLocale = env.LANG || env.LANGUAGE || env.LOCALE || Intl.DateTimeFormat().resolvedOptions().locale;
const timeZone = env.TIME_ZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;
const PORT = 3000;
const app = express();
const protocol = process.env.ENVIRONMENT === 'development' ? 'https' : 'http';
const key  = fs.readFileSync('./mkcert/localhost-key.pem', 'utf-8');
const cert = fs.readFileSync('./mkcert/localhost.pem', 'utf-8');
const server = protocol === 'https' ? https.createServer({key, cert}, app) : createServer(app);
const io = new Server(server);
const openai = new OpenAI({
    apiKey: env.OPENAI_APIKEY
});


const logger = winston.createLogger({
    level: "info",
    format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp(),
        winston.format.printf(({ level, message, timestamp }) => {
            const date = new Date(timestamp);
            const dateFormatter = new Intl.DateTimeFormat(systemLocale, {
                dateStyle: 'full',
                timeStyle: 'long',
                timeZone
            });

            return `${dateFormatter.format(date)} ${level}: ${message}`;
        })
    ),
    defaultMeta: { service: 'chat-service' },
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: "logs/app.log" }),
    ],
});

const transporter = createTransport({
    service: 'Gmail',
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: {
        user: 'thoschulte@gmail.com',
        pass: env.GMAIL_PASS
    }
});

const users = new Set();

app.use('/assets', express.static('assets'));

io.on('connection', async (socket) => {
    const token = socket.handshake.auth.token;

    if(token !== env.TOKEN) {
        socket.disconnect(true);

        return;
    }

    if (env.ENVIRONMENT !== 'development') {
        const response = await getBotResponse(`a user connected`);

        emitBotMessage(response, (message) => {
            socket.broadcast.emit('info user', message);
        });
    }

    users.add(socket.id);

    io.emit('users size', users.size);

    socket.broadcast.emit('new user', socket.id);

    socket.on('signal', data => {
        const { candidate, sdp } = data;

        if(candidate) {
            logger.info(`candidate: ${JSON.stringify(candidate.usernameFragment)}`);
        } else if(sdp) {
            logger.info(`sdp: ${JSON.stringify(sdp.type)}`);
        }

        socket.broadcast.emit('signal', data);
    });

    socket.on('update', ({from, to}) => {
        io.to(to).emit('new user', from, false);
    });

    socket.on('disconnect', async (reason) => {
        const text = `user ${socket.id} disconnected due to: ${reason}`;

        users.delete(socket.id);

        io.emit('users size', users.size);

        if (env.ENVIRONMENT !== 'development') {
            const response = await getBotResponse(`a user disconnected`);

            emitBotMessage(response, (message) => {
                socket.broadcast.emit('info user', message);
            });
        } else {
            socket.broadcast.emit('info user', text);
        }

        io.emit('disconnect user', socket.id);
    });

    socket.on('chat message', async (msg) => {
        const mailOptions = {
            from: 'thoschulte@gmail.com',
            to: 'thoschulte+chat@gmail.com',
            subject: 'Sending Email using Node.js Chat techstack.ch',
            text: msg
        };

        io.emit('chat message', {msg, id: socket.id});

        if (env.ENVIRONMENT !== 'development') {
            await transporter.sendMail(mailOptions, (error, info) => {
                if (error) {
                    logger.error(error);
                } else {
                    logger.info('email sent: ' + info.response);
                }
            });
        }

        if (env.ENVIRONMENT !== 'development') {
            const randomNumber = Math.floor(Math.random() * 4) + 1;

            if(randomNumber === 1) {
                const response = await getBotResponse(msg);

                emitBotMessage(response, (message) => {
                    io.emit('info user', message);
                });
            }
        }
    });
});

app.get('/', (req, res) => {
    res.redirect(`/room/${uuidv4(null, null, null)}`);
});

app.get('/room/:room', (req, res) => {
    if(users.size > 1) {
        res.sendStatus(405);
    } else {
        res.sendFile(join(__dirname, 'index.html'));
    }
});

app.get('/bot', async (req, res) => {
    const message = req.query.message ?? 'Hallo, moin und guten Tag!';
    const response = await openai.chat.completions.create({
        model: "gpt-4",
        messages: [
            {
                "role": "system",
                "content": `
                    You are Tom, a chatbot who secretly listens to a conversation between 
                    chat participants and reluctantly makes sarcastic comments in German or english, depending on selected input.
                    You are not answering from the first person perspective and avoid the word chatbot, the AI must not feel addressed.
                `
            }, {
                "role": "user",
                "content": message
            }
        ],
        temperature: 0.5,
        max_tokens: 64,
        top_p: 1,
    });

    res.send(response);
});

app.get('/ping', (_req, res) => {
    res.sendStatus(200);
});

app.get('/status', async (_req, res) => {
    const itr= users.entries();
    const entries = [];

    for(let i= 0; i < users.size; i++) {
        const result = itr.next();
        const values = result.value;

        from(values)
            .pipe(first())
            .subscribe((value) => {
                entries.push(value);
            });
    }

    res.send({ status: users.size, entries });
});

server.listen(PORT, () => {
    logger.log({
        level: 'info',
        message: `
            Locale: ${systemLocale}, timezone: ${timeZone}.
            Server is listening on ${protocol}://localhost:${PORT} in ${env.ENVIRONMENT}.
        `
    });
    // logger.info(`Server is listening on ${protocol}://localhost:${PORT} in ${env.ENVIRONMENT}.`);
});

const emitBotMessage = (response, cb) => {
    of(response)
        .pipe(
            map(obj => obj.data),
            map(obj => obj.choices),
            map(head),
            map(obj => obj.message),
            map(obj => obj.content)
        ).subscribe(cb);
};

const getBotResponse = async (message) => {
    try {
        return await axios.get(`//localhost:3000/bot?message=${message}`);
    } catch (error) {
        logger.error(error);
    }
};
