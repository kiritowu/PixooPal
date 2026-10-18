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
const WATCHDOG_INTERVAL_MS = 5_000;
const INACTIVITY_ALERT_MS = 45_000;

let connectionSequence = 0;
let shuttingDown = false;
const connectionByStream = new WeakMap();
const deviceState = {
  activeClient: null,
  activeConnection: null,
  connectedAt: null,
  lastActivityAt: null,
  lastCommand: null,
  lastDisconnectAt: null,
  disconnectCount: 0,
  bootstrapCount: 0,
  lastBootstrapAt: null,
  inactivityAlerted: false
};

const broker = await Aedes.createBroker({
  id: `pixoo-cloud-${process.pid}`,
  preConnect(_client, packet, done) {
    console.log(`[MQTT] Pixoo CONNECT: keepalive=${packet.keepalive}s; disabling broker timeout for firmware compatibility.`);
    packet.keepalive = 0;
    done(null, true);
  },
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
  const now = Date.now();
  const connection = connectionByStream.get(client.conn) || null;
  const downtime = deviceState.lastDisconnectAt ? now - deviceState.lastDisconnectAt : null;

  deviceState.activeClient = client;
  deviceState.activeConnection = connection;
  deviceState.connectedAt = now;
  deviceState.lastActivityAt = now;
  deviceState.inactivityAlerted = false;

  console.log(
    `[MQTT] Pixoo connected: ${client.id}; connection=${connection?.id || 'unknown'}; remote=${connection?.remote || 'unknown'}; reconnects=${deviceState.disconnectCount}`
  );

  if (downtime !== null) {
    console.log(`[RECOVERY] Pixoo MQTT reconnected after ${formatDuration(downtime)} offline.`);
  }
});
broker.on('subscribe', (subscriptions, client) => {
  markDeviceActivity(client);
  const topics = subscriptions.map(({ topic }) => topic);
  console.log(`[MQTT] Pixoo subscribed: ${client.id} -> ${topics.join(', ')}`);

  if (topics.includes(HEARTBEAT_TOPIC)) {
    publishHeartbeat();
  }
});
broker.on('clientDisconnect', (client) => {
  const now = Date.now();
  const connection = connectionByStream.get(client.conn) || null;

  if (shuttingDown) {
    console.log(`[MQTT] Pixoo disconnected during server shutdown: ${client.id}`);
    return;
  }

  if (deviceState.activeClient !== client) {
    console.log(`[MQTT] Superseded Pixoo session disconnected: ${client.id}; connection=${connection?.id || 'unknown'}`);
    return;
  }

  const sessionDuration = deviceState.connectedAt ? now - deviceState.connectedAt : 0;
  deviceState.activeClient = null;
  deviceState.activeConnection = null;
  deviceState.connectedAt = null;
  deviceState.lastDisconnectAt = now;
  deviceState.disconnectCount += 1;
  deviceState.inactivityAlerted = false;

  console.error(
    `[ALERT] Pixoo MQTT disconnected: client=${client.id}; connection=${connection?.id || 'unknown'}; session=${formatDuration(sessionDuration)}; lastCommand=${deviceState.lastCommand || 'none'}; disconnects=${deviceState.disconnectCount}`
  );
});
broker.on('clientError', (client, error) => {
  console.error(`[ALERT] Pixoo MQTT client error: client=${client?.id || 'unknown'}; error=${error.message}`);
});
broker.on('publish', (packet, client) => {
  if (!client || packet.topic !== DEVICE_SET_TOPIC) {
    return;
  }

  const body = parseJson(packet.payload.toString('utf-8'));

  if (!body?.Command) {
    return;
  }

  markDeviceActivity(client, body.Command);
  console.log(`[MQTT] Pixoo request: ${body.Command} PacketFlag=${numberValue(body.PacketFlag, 0)}`);

  if (body.Command === 'Device/Hearbeat') {
    publish(DEVICE_GET_TOPIC, {
      Command: 'Device/Hearbeat',
      DeviceId: numberValue(body.DeviceId, DEVICE_ID),
      PacketFlag: numberValue(body.PacketFlag, 0)
    });
    return;
  }

  publish(DEVICE_GET_TOPIC, buildDeviceResponse(body));
  console.log(`[MQTT] Pixoo response: ${body.Command} PacketFlag=${numberValue(body.PacketFlag, 0)}`);
});

const mqttServer = net.createServer((socket) => {
  const now = Date.now();
  const connection = {
    id: ++connectionSequence,
    remote: `${socket.remoteAddress || 'unknown'}:${socket.remotePort || 'unknown'}`,
    openedAt: now,
    lastRxAt: now
  };
  const stream = createPixooMqttStream(socket);

  connectionByStream.set(stream, connection);
  console.log(`[TCP] MQTT connection opened: connection=${connection.id}; remote=${connection.remote}`);

  socket.on('data', () => {
    connection.lastRxAt = Date.now();

    if (deviceState.activeConnection === connection) {
      deviceState.lastActivityAt = connection.lastRxAt;

      if (deviceState.inactivityAlerted) {
        deviceState.inactivityAlerted = false;
        console.log('[RECOVERY] Pixoo MQTT traffic resumed after an inactivity alert.');
      }
    }
  });
  socket.on('error', (error) => {
    console.error(`[ALERT] MQTT socket error: connection=${connection.id}; remote=${connection.remote}; error=${error.message}`);
  });
  socket.on('close', (hadError) => {
    console.log(
      `[TCP] MQTT connection closed: connection=${connection.id}; remote=${connection.remote}; lifetime=${formatDuration(Date.now() - connection.openedAt)}; bytesRead=${socket.bytesRead}; bytesWritten=${socket.bytesWritten}; hadError=${hadError}`
    );
  });

  broker.handle(stream);
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

const heartbeat = setInterval(publishHeartbeat, 60_000);
const watchdog = setInterval(checkDeviceWatchdog, WATCHDOG_INTERVAL_MS);

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
    recordBootstrapAttempt();
    console.log('[HTTP] /Test/GetIP');
    sendJson(response, 200, {
      ReturnCode: 0,
      ReturnMessage: '',
      CustonIP: PUBLIC_IP
    });
    return;
  }

  if (url.pathname === '/health') {
    const now = Date.now();
    const inactivityMs = deviceState.lastActivityAt ? now - deviceState.lastActivityAt : null;
    const healthy = Boolean(deviceState.activeClient) && inactivityMs !== null && inactivityMs < INACTIVITY_ALERT_MS;

    sendJson(response, healthy ? 200 : 503, {
      status: healthy ? 'online' : 'offline',
      connected: Boolean(deviceState.activeClient),
      clientId: deviceState.activeClient?.id || null,
      connectedForMs: deviceState.connectedAt ? now - deviceState.connectedAt : null,
      inactiveForMs: inactivityMs,
      lastCommand: deviceState.lastCommand,
      disconnectCount: deviceState.disconnectCount,
      bootstrapCount: deviceState.bootstrapCount
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
      IsResetAll: 1,
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
      DevicePublicIP: PUBLIC_IP,
      expire: 1,
      DeviceId: numberValue(body.DeviceId, DEVICE_ID),
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

function publishHeartbeat() {
  publish(HEARTBEAT_TOPIC, { Command: 'Device/Hearbeat' });
}

function buildDeviceResponse(body) {
  const base = {
    ReturnCode: 0,
    ReturnMessage: '',
    DeviceId: numberValue(body.DeviceId, DEVICE_ID),
    Command: body.Command,
    PacketFlag: numberValue(body.PacketFlag, 0)
  };
  const disabledSchedule = {
    IsEnable: 0,
    StartTime: 32400,
    EndTime: 36000,
    VoiceEnable: 0,
    WeekArray: [0, 0, 0, 0, 0, 0, 0]
  };

  switch (body.Command) {
    case 'Device/BindUser':
      return { ...base, NewHost: 1 };
    case 'Device/Connect':
      return {
        ...base,
        Software: numberValue(body.Software, 0),
        LocalToken: 0,
        ExpertList: []
      };
    case 'Device/GetAppIP':
      return { ...base, AppIpList: [] };
    case 'Device/GetCustomGalleryTimeList':
    case 'Device/GetSubscribeGalleryTimeList':
      return { ...base, TimeList: [] };
    case 'Channel/GetNightView':
      return { ...base, OnOff: 0, StartTime: 0, EndTime: 360, Brightness: 50 };
    case 'Channel/GetAllCustomTime':
      return {
        ...base,
        TimeList: [
          { ...disabledSchedule },
          { ...disabledSchedule },
          { ...disabledSchedule }
        ]
      };
    case 'Channel/GetEqTime':
    case 'Channel/GetSubscribeTime':
      return { ...base, ...disabledSchedule };
    case 'Channel/OnOffScreen': {
      const { Command: _command, ...response } = base;
      return response;
    }
    case 'Device/GetUserDefineList':
      return { ...base, AllFlag: 1, HasNum: 0, FileList: [], FileNum: 0 };
    case 'Device/GetHotList':
      return { ...base, FileList: [], FileNum: 0 };
    case 'Device/GetTimePlan':
      return { ...base, IsEnable: 0, TimePlanUpdateTime: 0, PlanItem: [] };
    case 'Device/GetAlarm':
      return { ...base, AlarmList: [] };
    case 'Device/GetMemorial':
      return { ...base, MemorialList: [] };
    case 'Device/GetTimeDialFont':
      return { ...base, FontList: [] };
    case 'Device/GetTimeDialAppPic':
      return { ...base, PicList: [] };
    case 'Device/GetClockList':
      return { ...base, ClockList: [] };
    case 'Device/GetEqDataList':
      return { ...base, EqDataList: [] };
    case 'Channel/GetNotifyList':
      return { ...base, NotifyList: [] };
    case 'Device/GetHistoryClockList':
      return { ...base, HistoryClockList: [] };
    case 'Weather/GetRealWeatherInfo':
    case 'Weather/GetForecastWeatherInfo':
      return { ...base, expire: 1 };
    case 'Sys/GetConf':
      return {
        ...base,
        CurClockId: 0,
        OnOff: 0,
        StartTime: 0,
        EndTime: 360,
        Brightness: 100,
        ChannelIndex: 0,
        RotationFlag: 0,
        ClockTime: 60,
        GalleryTime: 60,
        SingleGalleyTime: -1,
        GalleryShowTimeFlag: -1,
        Time24Flag: 0,
        LocationMode: 0,
        LocationCityName: '',
        LocationCityId: 0,
        Longitude: 0,
        Latitude: 0,
        TimeZoneMode: 0,
        TimeZoneInfo: 0,
        TemperatureMode: 0,
        StartupFileId: '',
        GyrateAngle: 0,
        DeviceAutoUpdate: 0,
        TimeZoneName: 'UTC',
        TimeZoneValue: 'UTC0',
        WhiteBalanceR: 100,
        WhiteBalanceG: 100,
        WhiteBalanceB: 100,
        MirrorFlag: 0,
        HighLight: 0,
        DateFormat: 0,
        LcdImageArray: ['', '', '', '', ''],
        StartUpClockId: 0,
        OnOffVolume: 1,
        NotificationSound: 80,
        BluetoothAutoConnect: 1,
        AutoPowerOff: 0,
        DisableMic: 0,
        Language: 0,
        ScreenProtection: 0,
        LockScreenTime: 600,
        ShowGrid1632: 1,
        ColorTemp: 0,
        Wind: 0,
        StartUpClockOnOff: 0,
        SoundEffectMode: 1
      };
    default:
      return base;
  }
}

function markDeviceActivity(client, command) {
  if (client !== deviceState.activeClient) {
    return;
  }

  deviceState.lastActivityAt = Date.now();

  if (command) {
    deviceState.lastCommand = command;
  }
}

function checkDeviceWatchdog() {
  if (!deviceState.activeClient || !deviceState.lastActivityAt || deviceState.inactivityAlerted) {
    return;
  }

  const inactiveFor = Date.now() - deviceState.lastActivityAt;

  if (inactiveFor >= INACTIVITY_ALERT_MS) {
    deviceState.inactivityAlerted = true;
    console.error(
      `[ALERT] Pixoo MQTT is connected but inactive for ${formatDuration(inactiveFor)}; lastCommand=${deviceState.lastCommand || 'none'}.`
    );
  }
}

function recordBootstrapAttempt() {
  const now = Date.now();
  const sincePrevious = deviceState.lastBootstrapAt ? now - deviceState.lastBootstrapAt : null;
  deviceState.bootstrapCount += 1;
  deviceState.lastBootstrapAt = now;

  if (deviceState.bootstrapCount > 1) {
    console.error(
      `[ALERT] Pixoo bootstrap restarted: attempt=${deviceState.bootstrapCount}; sincePrevious=${formatDuration(sincePrevious)}; mqttConnected=${Boolean(deviceState.activeClient)}.`
    );
  }
}

function formatDuration(milliseconds) {
  if (milliseconds === null || milliseconds === undefined) {
    return 'unknown';
  }

  if (milliseconds < 1_000) {
    return `${milliseconds}ms`;
  }

  return `${(milliseconds / 1_000).toFixed(1)}s`;
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
  shuttingDown = true;
  console.log(`[Shutdown] ${signal}`);
  clearInterval(heartbeat);
  clearInterval(watchdog);
  await Promise.all([
    new Promise((resolve) => httpServer.close(resolve)),
    new Promise((resolve) => mqttServer.close(resolve)),
    broker.close()
  ]);
}
