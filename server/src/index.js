import http from 'http';
import express from 'express';
import { Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { CityRoom } from './rooms/CityRoom.js';

const port = Number(process.env.PORT || 2567) || 2567;

const app = express();
app.get('/', (_req, res) => res.status(200).send('webgl-mmo-server ok'));

const server = http.createServer(app);

const gameServer = new Server({
  transport: new WebSocketTransport({ server }),
});

gameServer.define('city', CityRoom);

server.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`[mmo] listening on :${port} (room: city)`);
});

