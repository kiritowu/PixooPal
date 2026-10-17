import { Buffer } from 'node:buffer';

const INIT_V2_PATH = '/Device/InitV2';
const UPDATE_DEVICE_PUBLIC_IP_PATH = '/Device/UpdateDevicePublicIP';
const MAX_BODY_BYTES = 64 * 1024;

/**
 * @typedef {import('node:http').IncomingMessage & { url?: string }} DivoomRequest
 */

/**
 * @param {DivoomRequest} request
 */
export async function prepareDivoomGetBody(request) {
  const path = getSupportedPath(request.url);

  if (request.method !== 'GET' || !path) {
    return;
  }

  const contentLength = Number.parseInt(String(request.headers['content-length'] ?? ''), 10);
  const bodyText = await readIncomingBody(request);

  if (!bodyText.trim()) {
    console.warn(
      `[PixooPal MITM] GET ${path} arrived without readable body. Content-Length=${Number.isFinite(contentLength) ? contentLength : '(empty)'}.`
    );
    return;
  }

  const payload = parseDivoomBody(bodyText);

  if (!payload) {
    console.warn(
      `[PixooPal MITM] GET ${path} body was present (${Buffer.byteLength(bodyText)} bytes) but could not be parsed.`
    );
    return;
  }

  request.url = appendPayloadToQuery(request.url, payload);
  appendPayloadToHeaders(request, payload);

  console.log(
    `[PixooPal MITM] Captured GET ${path} body: bytes=${Buffer.byteLength(bodyText)}, DeviceMacAddr=${stringValue(payload.DeviceMacAddr) || '(empty)'}, PacketFlag=${stringValue(payload.PacketFlag) || '(empty)'}`
  );
}

/**
 * @param {string | undefined} url
 */
function getSupportedPath(url) {
  try {
    const path = new URL(url || '', 'http://pixoopal.local').pathname;
    return [INIT_V2_PATH, UPDATE_DEVICE_PUBLIC_IP_PATH].includes(path) ? path : '';
  } catch {
    return '';
  }
}

/**
 * @param {DivoomRequest} request
 * @returns {Promise<string>}
 */
function readIncomingBody(request) {
  const contentLength = Number.parseInt(String(request.headers['content-length'] ?? ''), 10);
  const transferEncoding = String(request.headers['transfer-encoding'] ?? '').trim();

  if ((!Number.isFinite(contentLength) || contentLength <= 0) && !transferEncoding) {
    return Promise.resolve('');
  }

  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let totalBytes = 0;

    request.on('data', (/** @type {Buffer | string} */ chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.length;

      if (totalBytes > MAX_BODY_BYTES) {
        request.destroy(new Error('Divoom GET request body is too large.'));
        return;
      }

      chunks.push(buffer);
    });

    request.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf-8'));
    });

    request.on('error', reject);
  });
}

/**
 * @param {string} bodyText
 * @returns {Record<string, unknown> | null}
 */
function parseDivoomBody(bodyText) {
  const trimmed = bodyText.trim();

  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith('{')) {
    try {
      const payload = JSON.parse(trimmed);
      return isRecord(payload) ? payload : null;
    } catch {
      return parseJsonLikeDivoomBody(trimmed);
    }
  }

  const params = new URLSearchParams(trimmed);
  /** @type {Record<string, unknown>} */
  const payload = {};

  for (const [key, value] of params.entries()) {
    payload[key] = value;
  }

  return Object.keys(payload).length > 0 ? payload : null;
}

/**
 * @param {string} bodyText
 * @returns {Record<string, unknown> | null}
 */
function parseJsonLikeDivoomBody(bodyText) {
  const deviceMacAddr = matchJsonStringField(bodyText, 'DeviceMacAddr');
  const packetFlag = matchJsonNumberField(bodyText, 'PacketFlag');

  if (!deviceMacAddr && packetFlag === undefined) {
    return null;
  }

  /** @type {Record<string, unknown>} */
  const payload = {};

  if (deviceMacAddr) {
    payload.DeviceMacAddr = deviceMacAddr;
  }

  if (packetFlag !== undefined) {
    payload.PacketFlag = packetFlag;
  }

  return payload;
}

/**
 * @param {string | undefined} requestUrl
 * @param {Record<string, unknown>} payload
 */
function appendPayloadToQuery(requestUrl, payload) {
  const url = new URL(requestUrl || INIT_V2_PATH, 'http://pixoopal.local');

  for (const [key, value] of Object.entries(payload)) {
    if (!isQuerySafeValue(value) || url.searchParams.has(key)) {
      continue;
    }

    url.searchParams.set(key, String(value));
  }

  return `${url.pathname}${url.search}`;
}

/**
 * @param {DivoomRequest} request
 * @param {Record<string, unknown>} payload
 */
function appendPayloadToHeaders(request, payload) {
  const deviceMacAddr = stringValue(payload.DeviceMacAddr);
  const packetFlag = stringValue(payload.PacketFlag);

  if (deviceMacAddr) {
    request.headers['x-pixoopal-initv2-device-mac-addr'] = deviceMacAddr;
  }

  if (packetFlag) {
    request.headers['x-pixoopal-initv2-packet-flag'] = packetFlag;
  }
}

/**
 * @param {string} bodyText
 * @param {string} field
 */
function matchJsonStringField(bodyText, field) {
  const match = new RegExp(`"${field}"\\s*:\\s*"([^"]*)"`, 'i').exec(bodyText);
  return match?.[1] ?? '';
}

/**
 * @param {string} bodyText
 * @param {string} field
 */
function matchJsonNumberField(bodyText, field) {
  const match = new RegExp(`"${field}"\\s*:\\s*(-?\\d+)`, 'i').exec(bodyText);
  return match ? Number.parseInt(match[1], 10) : undefined;
}

/**
 * @param {unknown} value
 */
function isQuerySafeValue(value) {
  return ['string', 'number', 'boolean'].includes(typeof value);
}

/**
 * @param {unknown} value
 */
function stringValue(value) {
  return value === undefined || value === null ? '' : String(value);
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
