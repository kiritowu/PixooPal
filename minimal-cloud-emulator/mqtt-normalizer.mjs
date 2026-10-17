import { Buffer } from 'node:buffer';
import { Duplex } from 'node:stream';

const DEVICE_SET_TOPIC = 'divoom/2/12345/set';
const DEVICE_SET_TOPIC_BUFFER = Buffer.from(DEVICE_SET_TOPIC, 'utf-8');

export function createPixooMqttStream(socket) {
  let inputBuffer = Buffer.alloc(0);
  let uncorkScheduled = false;

  const stream = new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      // mqtt-packet writes headers and bodies separately, but Pixoo expects them in one TCP flush.
      if (!uncorkScheduled) {
        socket.cork();
        uncorkScheduled = true;
        queueMicrotask(() => {
          uncorkScheduled = false;
          socket.uncork();
        });
      }

      socket.write(chunk);
      callback();
    },
    destroy(error, callback) {
      socket.destroy(error ?? undefined);
      callback(error);
    }
  });

  socket.on('data', (chunk) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    inputBuffer = Buffer.concat([inputBuffer, buffer]);
    inputBuffer = flushPackets(inputBuffer, stream);
  });
  socket.on('close', () => {
    stream.push(null);
    stream.destroy();
  });
  socket.on('error', (error) => stream.destroy(error));

  return stream;
}

function flushPackets(buffer, stream) {
  let cursor = 0;

  while (cursor < buffer.length) {
    const bounds = readPacketBounds(buffer, cursor);

    if (!bounds) {
      break;
    }

    const packet = buffer.subarray(cursor, bounds.end);
    stream.push(normalizePublish(packet, bounds.headerLength, bounds.remainingLength));
    cursor = bounds.end;
  }

  return cursor ? buffer.subarray(cursor) : buffer;
}

function readPacketBounds(buffer, offset) {
  let multiplier = 1;
  let remainingLength = 0;

  for (let index = offset + 1; index < Math.min(buffer.length, offset + 5); index += 1) {
    const byte = buffer[index];
    remainingLength += (byte & 127) * multiplier;

    if ((byte & 128) === 0) {
      const headerLength = index - offset + 1;
      const end = offset + headerLength + remainingLength;
      return buffer.length >= end ? { headerLength, remainingLength, end } : null;
    }

    multiplier *= 128;
  }

  return null;
}

function normalizePublish(packet, headerLength, remainingLength) {
  const packetType = packet[0] >> 4;
  const qos = ((packet[0] & 0x0f) >> 1) & 0x03;

  if (packetType !== 3 || qos === 0 || packet.length < headerLength + 2) {
    return packet;
  }

  const declaredTopicLength = packet.readUInt16BE(headerLength);

  if (declaredTopicLength <= remainingLength - 2) {
    return packet;
  }

  const topicIndex = packet.indexOf(DEVICE_SET_TOPIC_BUFFER, headerLength);

  if (topicIndex < 0) {
    return packet;
  }

  const packetIdIndex = topicIndex + DEVICE_SET_TOPIC_BUFFER.length;
  const payloadIndex = packetIdIndex + 2;

  if (packet.length < payloadIndex + 1 || packet[payloadIndex] !== 0x7b) {
    return packet;
  }

  const packetId = packet.subarray(packetIdIndex, payloadIndex);
  const payload = packet.subarray(payloadIndex);
  const correctedLength = 2 + DEVICE_SET_TOPIC_BUFFER.length + 2 + payload.length;

  console.warn('[MQTT] Corrected malformed Pixoo publish packet.');

  return Buffer.concat([
    Buffer.from([packet[0], ...encodeRemainingLength(correctedLength)]),
    Buffer.from([0, DEVICE_SET_TOPIC_BUFFER.length]),
    DEVICE_SET_TOPIC_BUFFER,
    packetId,
    payload
  ]);
}

function encodeRemainingLength(value) {
  const bytes = [];
  let remaining = value;

  do {
    let byte = remaining % 128;
    remaining = Math.floor(remaining / 128);

    if (remaining) {
      byte |= 128;
    }

    bytes.push(byte);
  } while (remaining);

  return bytes;
}
