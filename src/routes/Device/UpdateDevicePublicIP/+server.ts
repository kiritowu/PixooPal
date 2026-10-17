import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { divoomJson, divoomOptions } from '$lib/server/divoomHttp';

export const GET: RequestHandler = async (event) => handleUpdateDevicePublicIP(event);
export const POST: RequestHandler = async (event) => handleUpdateDevicePublicIP(event);
export const OPTIONS: RequestHandler = async () => divoomOptions();

async function handleUpdateDevicePublicIP({ request, url }: RequestEvent) {
  const payload =
    request.method === 'GET'
      ? Object.fromEntries(url.searchParams.entries())
      : await readMaybeJsonBody(request);
  const packetFlag = normalizeNumber(payload.PacketFlag, 0);

  console.log(
    `[PixooPal MITM] Pixoo reached /Device/UpdateDevicePublicIP. Acknowledging local public IP update with PacketFlag=${packetFlag}.`
  );

  return divoomJson({
    ReturnCode: 0,
    ReturnMessage: '',
    Command: 'Device/UpdateDevicePublicIP',
    PacketFlag: packetFlag
  });
}

async function readMaybeJsonBody(request: Request): Promise<Record<string, unknown>> {
  const bodyText = await request.text().catch(() => '');

  if (!bodyText.trim()) {
    return {};
  }

  try {
    const payload = JSON.parse(bodyText) as unknown;
    return isRecord(payload) ? payload : {};
  } catch {
    console.warn(
      '[PixooPal MITM] /Device/UpdateDevicePublicIP received a non-JSON request body.'
    );
    return {};
  }
}

function normalizeNumber(value: unknown, fallback: number) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
