import type { RequestHandler } from '@sveltejs/kit';
import { divoomJson, divoomOptions } from '$lib/server/divoomHttp';

export const GET: RequestHandler = async () => handleUpdateDevicePublicIP();
export const POST: RequestHandler = async () => handleUpdateDevicePublicIP();
export const OPTIONS: RequestHandler = async () => divoomOptions();

function handleUpdateDevicePublicIP() {
  console.log(
    '[PixooPal MITM] Pixoo reached /Device/UpdateDevicePublicIP. Acknowledging local public IP update.'
  );

  return divoomJson({
    ReturnCode: 0,
    ReturnMessage: '',
    DevicePublicIP: '127.0.0.1',
    Command: 'Device/UpdateDevicePublicIP'
  });
}
