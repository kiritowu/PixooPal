import http from 'node:http';
import net from 'node:net';
import { Buffer } from 'node:buffer';
import { Aedes } from 'aedes';
import { createPixooMqttStream } from './mqtt-normalizer.mjs';

const HTTP_PORT = readPort('HTTP_PORT', 80);
const MQTT_PORT = readPort('MQTT_PORT', 1883);
const HOST_IP = process.env.PIXOOPAL_HOST_IP?.trim() || '10.42.0.1';
const PUBLIC_IP = process.env.PUBLIC_IP?.trim() || '80.92.211.126';
const DEVICE_ID = 12345;
const DEVICE_TOKEN = 'pixoopal';
const MQTT_PASSWORD = DEVICE_TOKEN;
const DEVICE_SET_TOPIC = `divoom/2/${DEVICE_ID}/set`;
const DEVICE_GET_TOPIC = `divoom/2/${DEVICE_ID}/get`;
const HEARTBEAT_TOPIC = 'divoom/2/DeviceHeart';
const MAX_BODY_BYTES = 64 * 1024;

const broker = await Aedes.createBroker({
  id: `pixoo-cloud-${process.pid}`,
  authenticate(client, _username, password, done) {
    const suppliedPassword = password?.toString('utf-8') || '';
    const accepted = !suppliedPassword || suppliedPassword === MQTT_PASSWORD;

    if (!accepted) {
      const error = new Error('Bad username or password');
      error.returnCode = 4;
      done(error, false);
      return;
    }

    done(null, true);
  }
});

broker.on('clientReady', (client) => {
  console.log(`[MQTT] Pixoo connected: ${client.id}`);
});
broker.on('clientDisconnect', (client) => {
  console.log(`[MQTT] Pixoo disconnected: ${client.id}`);
});
broker.on('clientError', (client, error) => {
  console.warn(`[MQTT] Client error: ${client?.id || '(unknown)'}: ${error.message}`);
});
broker.on('publish', (packet, client) => {
  if (!client || packet.topic !== DEVICE_SET_TOPIC) {
    return;
  }

  const body = parseJson(packet.payload.toString('utf-8'));

  if (body?.Command !== 'Device/AppRestartMqtt') {
    return;
  }

  publish(DEVICE_GET_TOPIC, {
    ReturnCode: 0,
    ReturnMessage: '',
    DeviceId: numberValue(body.DeviceId, DEVICE_ID),
    Command: 'Device/AppRestartMqtt',
    PacketFlag: numberValue(body.PacketFlag, 0)
  });
});

const mqttServer = net.createServer((socket) => {
  broker.handle(createPixooMqttStream(socket));
});
const httpServer = http.createServer(async (request, response) => {
  try {
    await handleHttp(request, response);
  } catch (error) {
    console.error(`[HTTP] ${error instanceof Error ? error.message : String(error)}`);
    sendJson(response, 500, { ReturnCode: -1, ReturnMessage: 'Internal server error' });
  }
});

await Promise.all([
  listen(mqttServer, MQTT_PORT),
  listen(httpServer, HTTP_PORT)
]);

console.log(`[HTTP] Listening on 0.0.0.0:${HTTP_PORT}`);
console.log(`[MQTT] Listening on 0.0.0.0:${MQTT_PORT}`);
console.log(`[Config] Advertising MQTT broker ${HOST_IP}:${MQTT_PORT}`);

publish(HEARTBEAT_TOPIC, { Command: 'Device/Hearbeat' });
const heartbeat = setInterval(
  () => publish(HEARTBEAT_TOPIC, { Command: 'Device/Hearbeat' }),
  60_000
);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => shutdown(signal));
}

async function handleHttp(request, response) {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);

  if (request.method === 'OPTIONS') {
    sendEmpty(response, 204);
    return;
  }

  if (!['GET', 'POST'].includes(request.method || '')) {
    sendJson(response, 405, { ReturnCode: -1, ReturnMessage: 'Method not allowed' });
    return;
  }

  if (url.pathname === '/Test/GetIP') {
    console.log('[HTTP] /Test/GetIP');
    sendJson(response, 200, {
      ReturnCode: 0,
      ReturnMessage: '',
      CustonIP: PUBLIC_IP
    });
    return;
  }

  const body = await readJsonBody(request);

  if (url.pathname === '/Device/InitV2') {
    const packetFlag = numberValue(body.PacketFlag, 0);
    const now = Math.floor(Date.now() / 1000);

    console.log(`[HTTP] /Device/InitV2 PacketFlag=${packetFlag}`);
    sendJson(response, 200, {
      ReturnCode: 0,
      ReturnMessage: '',
      MqttPort: MQTT_PORT,
      DevicePublicIP: PUBLIC_IP,
      IP: HOST_IP,
      BackupIP: HOST_IP,
      lot: 0,
      lat: 0,
      SummerZone: 0,
      TimeZoneCode: 'UTC',
      UTCTime: now,
      DeviceId: DEVICE_ID,
      UserId: numberValue(body.BindUserId, 0),
      LogLevel: 0,
      IsResetAll: 0,
      DeviceToken: DEVICE_TOKEN,
      ServerType: 1,
      LastClockId: 0,
      OfflineTime: 0,
      OnlineTime: now,
      ScreenOnOff: 1,
      CustomType: 0,
      IsNewDevice: 0,
      Command: 'Device/InitV2',
      PacketFlag: packetFlag
    });
    return;
  }

  if (url.pathname === '/Device/UpdateDevicePublicIP') {
    const packetFlag = numberValue(body.PacketFlag, 0);

    console.log(`[HTTP] /Device/UpdateDevicePublicIP PacketFlag=${packetFlag}`);
    sendJson(response, 200, {
      ReturnCode: 0,
      ReturnMessage: '',
      Command: 'Device/UpdateDevicePublicIP',
      PacketFlag: packetFlag
    });
    return;
  }

  console.warn(`[HTTP] Unhandled request: ${request.method} ${url.pathname}`);
  sendJson(response, 404, {
    ReturnCode: 404,
    ReturnMessage: 'Not found',
    Command: typeof body.Command === 'string' ? body.Command : url.pathname
  });
}

async function readJsonBody(request) {
  const chunks = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    totalBytes += chunk.length;

    if (totalBytes > MAX_BODY_BYTES) {
      throw new Error('Request body is too large.');
    }

    chunks.push(chunk);
  }

  if (!chunks.length) {
    return {};
  }

  return parseJson(Buffer.concat(chunks).toString('utf-8')) || {};
}

function sendJson(response, statusCode, body) {
  const payload = JSON.stringify(body);

  response.writeHead(statusCode, {
    Server: 'nginx',
    'Content-Type': 'application/json; charset=UTF-8',
    'Content-Length': Buffer.byteLength(payload),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    Connection: 'keep-alive'
  });
  response.end(payload);
}

function sendEmpty(response, statusCode) {
  response.writeHead(statusCode, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization'
  });
  response.end();
}

function publish(topic, body) {
  broker.publish({
    cmd: 'publish',
    topic,
    payload: Buffer.from(JSON.stringify(body)),
    qos: 0,
    retain: false,
    dup: false
  }, (error) => {
    if (error) {
      console.warn(`[MQTT] Publish failed for ${topic}: ${error.message}`);
    }
  });
}

function parseJson(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function numberValue(value, fallback) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readPort(name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isInteger(value) && value > 0 && value <= 65535 ? value : fallback;
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', resolve);
  });
}

async function shutdown(signal) {
  console.log(`[Shutdown] ${signal}`);
  clearInterval(heartbeat);
  await Promise.all([
    new Promise((resolve) => httpServer.close(resolve)),
    new Promise((resolve) => mqttServer.close(resolve)),
    broker.close()
  ]);
}
