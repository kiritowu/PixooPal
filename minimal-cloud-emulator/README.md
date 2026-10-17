# Minimal Pixoo cloud emulator

This folder contains only the services observed during the Pixoo 64 firmware bootstrap:

- `GET /Test/GetIP`
- `GET /Device/InitV2` with a JSON request body
- `GET /Device/UpdateDevicePublicIP` with a JSON request body
- MQTT on port `1883`, including heartbeat handling and startup-command acknowledgements

It intentionally has no web UI, image rendering, clockfaces, Home Assistant integration, HTTPS, storage, discovery, or local Pixoo control.

## Raspberry Pi setup

The Pi hotspot address is expected to be `10.42.0.1`. Change `PIXOOPAL_HOST_IP` in `docker-compose.yaml` if yours differs.

Stop the full PixooPal container first because both services require ports `80` and `1883`:

```bash
cd /opt/pixoopal
sudo docker compose down
```

Run the minimal emulator from the cloned repository:

```bash
cd /opt/pixoopal-src/minimal-cloud-emulator
sudo docker compose up -d --build
sudo docker compose logs -f
```

Keep the existing dnsmasq overrides pointing the Divoom hostnames at the Pi:

```ini
address=/appin.divoom-gz.com/10.42.0.1
address=/app.divoom-gz.com/10.42.0.1
```

Then power-cycle the Pixoo. A successful bootstrap produces logs for all three HTTP routes followed by `Pixoo connected`.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PIXOOPAL_HOST_IP` | `10.42.0.1` | MQTT address returned to the Pixoo |
| `HTTP_PORT` | `80` | Cloud-emulation HTTP port |
| `MQTT_PORT` | `1883` | Embedded MQTT port |
| `PUBLIC_IP` | `80.92.211.126` | Harmless public-IP value returned during bootstrap |

The Docker image has no compilation step. It installs one runtime dependency and copies two JavaScript files, so it builds much faster on a Raspberry Pi than the full PixooPal application.

See [DEBUGGING.md](./DEBUGGING.md) for the frequently used hotspot, DHCP, DNS, MQTT, HTTP, Docker, packet-capture, and power-diagnostics commands.
