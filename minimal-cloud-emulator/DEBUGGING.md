# Pixoo local-cloud debugging commands

This runbook assumes:

- Raspberry Pi hotspot connection: `PixooLocal`
- Pi hotspot address: `10.42.0.1`
- Pixoo address: `10.42.0.8`
- Pixoo MAC address: `d4:8c:49:c1:8c:7c`
- Project directory: `/opt/pixoopal-src/minimal-cloud-emulator`

If DHCP assigns a different Pixoo address, replace `10.42.0.8` in the commands below.

## Quick health check

```bash
nmcli connection show --active
iw dev wlan0 info | grep -E 'type|channel'
ip -br address show wlan0
ip route
ip neigh show dev wlan0
sudo iw dev wlan0 station dump
sudo docker compose -f /opt/pixoopal-src/minimal-cloud-emulator/docker-compose.yaml ps
```

Expected hotspot state:

```text
PixooLocal
type AP
wlan0 UP 10.42.0.1/24
```

## Hotspot control

Restart only the hotspot:

```bash
sudo nmcli connection down PixooLocal
sudo nmcli connection up PixooLocal
```

Restart the Wi-Fi radio and hotspot:

```bash
sudo nmcli radio wifi off
sleep 3
sudo nmcli radio wifi on
sudo nmcli connection up PixooLocal
```

Restarting the hotspot disconnects every wireless client. Power-cycle the Pixoo afterward and allow it time to reconnect.

Show the hotspot configuration:

```bash
nmcli -f \
connection.id,802-11-wireless.mode,802-11-wireless.band,802-11-wireless.channel,ipv4.method,ipv4.addresses,ipv4.shared-dhcp-range \
connection show PixooLocal
```

Change the hotspot password:

```bash
sudo nmcli connection modify PixooLocal 802-11-wireless-security.psk 'NEW_PASSWORD'
sudo nmcli connection down PixooLocal
sudo nmcli connection up PixooLocal
```

## Connected Wi-Fi clients

Show associated stations:

```bash
sudo iw dev wlan0 station dump
```

Check only the Pixoo:

```bash
sudo iw dev wlan0 station get d4:8c:49:c1:8c:7c
```

Important healthy fields are:

```text
authorized: yes
authenticated: yes
associated: yes
```

Show link quality and failures:

```bash
sudo iw dev wlan0 station dump |
  grep -E 'Station|inactive|signal:|rx bytes|tx bytes|rx packets|tx packets|rx bitrate|tx bitrate|tx retries|tx failed|authorized|authenticated|associated'
```

## DHCP and IP-address checks

Show recent Pixoo DHCP activity:

```bash
sudo journalctl -u NetworkManager \
  --since '-10 minutes' --no-pager |
  grep -Ei 'd4:8c:49:c1:8c:7c|DHCPDISCOVER|DHCPOFFER|DHCPREQUEST|DHCPACK'
```

A complete DHCP exchange is:

```text
DHCPDISCOVER
DHCPOFFER
DHCPREQUEST
DHCPACK
```

Show the neighbour table:

```bash
ip neigh show dev wlan0
```

Clear a stale or failed Pixoo neighbour entry:

```bash
sudo ip neigh del 10.42.0.8 dev wlan0 2>/dev/null
```

Test reachability:

```bash
ping -c 3 10.42.0.8
```

`FAILED` in the neighbour table means the Pi sent ARP requests but the Pixoo did not answer. DHCP may still have succeeded earlier; check whether the Pixoo remains associated with `station dump`.

## DNS interception

Confirm the Pixoo hostname resolves to the Pi:

```bash
dig @10.42.0.1 appin.divoom-gz.com +short
dig @10.42.0.1 app.divoom-gz.com +short
```

Expected answer:

```text
10.42.0.1
```

Find the NetworkManager dnsmasq process:

```bash
ps -ef | grep '[d]nsmasq'
```

Check DNS and DHCP listeners:

```bash
sudo ss -luntp | grep -E ':(53|67)\b'
```

The standalone `dnsmasq.service` should normally remain disabled when NetworkManager manages the shared hotspot:

```bash
systemctl is-enabled dnsmasq
systemctl is-active dnsmasq
```

## Emulator container

Change to the project directory:

```bash
cd /opt/pixoopal-src/minimal-cloud-emulator
```

Show container status:

```bash
sudo docker compose ps
```

Build or recreate the emulator:

```bash
sudo docker compose up -d --build --force-recreate
```

Restart without rebuilding:

```bash
sudo docker compose restart
```

Stop the emulator:

```bash
sudo docker compose down
```

Show recent logs:

```bash
sudo docker compose logs --timestamps --no-color --since 10m
```

Follow only new logs and save them in the user's home directory:

```bash
sudo docker compose logs --timestamps --no-color --tail=0 -f 2>&1 |
  tee ~/pixoo-emulator-live.log
```

Stop following with `Ctrl+C`. The container continues running.

Verify listening ports:

```bash
sudo ss -lntp | grep -E ':(80|1883)\b'
```

Verify the deployed commit:

```bash
cd /opt/pixoopal-src
git rev-parse --short HEAD
git status --short
```

Update and rebuild:

```bash
cd /opt/pixoopal-src
sudo git pull --ff-only
cd minimal-cloud-emulator
sudo docker compose up -d --build --force-recreate
```

## Pixoo HTTP API

Read the current configuration:

```bash
curl -sS --connect-timeout 5 --max-time 15 \
  -H 'Content-Type: application/json' \
  -H 'Connection: close' \
  -d '{"Command":"Channel/GetAllConf"}' \
  http://10.42.0.8/post
```

Measure connection and response latency:

```bash
curl -sS --connect-timeout 10 --max-time 30 \
  -o /tmp/pixoo-response.json \
  -w 'connect=%{time_connect}s start-transfer=%{time_starttransfer}s total=%{time_total}s\n' \
  -H 'Content-Type: application/json' \
  -H 'Connection: close' \
  -d '{"Command":"Channel/GetAllConf"}' \
  http://10.42.0.8/post

cat /tmp/pixoo-response.json
```

Change brightness:

```bash
curl -sS \
  -H 'Content-Type: application/json' \
  -d '{"Command":"Channel/SetBrightness","Brightness":50}' \
  http://10.42.0.8/post
```

Display text:

```bash
curl -sS \
  -H 'Content-Type: application/json' \
  -d '{
    "Command":"Draw/SendHttpText",
    "TextId":1,
    "x":0,
    "y":20,
    "dir":0,
    "font":4,
    "TextWidth":64,
    "TextString":"Hello!",
    "speed":50,
    "color":"#FFFFFF",
    "align":1
  }' \
  http://10.42.0.8/post
```

Clear that text:

```bash
curl -sS \
  -H 'Content-Type: application/json' \
  -d '{"Command":"Draw/ClearHttpText","TextId":1}' \
  http://10.42.0.8/post
```

## Packet captures

Capture Pixoo DHCP and ARP traffic for 60 seconds:

```bash
sudo timeout 60 tcpdump -ni wlan0 -e -tttt -vv \
  'ether host d4:8c:49:c1:8c:7c and (arp or udp port 67 or udp port 68)' \
  2>&1 | tee ~/pixoo-dhcp-arp.txt
```

Capture MQTT traffic for 120 seconds:

```bash
sudo timeout 120 tcpdump -ni wlan0 -s0 -tttt -vvv -X \
  'host 10.42.0.8 and tcp port 1883' \
  2>&1 | tee ~/pixoo-mqtt-120s.txt
```

Capture local HTTP API traffic for 30 seconds:

```bash
sudo timeout 30 tcpdump -ni wlan0 -s0 -tttt -vvv -A \
  'host 10.42.0.8 and tcp port 80' \
  2>&1 | tee ~/pixoo-http-30s.txt
```

Start the relevant capture first, then power-cycle the Pixoo or send the request being diagnosed.

## Raspberry Pi power and kernel errors

Check current and historical throttling flags:

```bash
vcgencmd get_throttled
```

Healthy output:

```text
throttled=0x0
```

Check recent power and Wi-Fi driver errors:

```bash
sudo journalctl -k --since '-15 minutes' --no-pager |
  grep -Ei 'under-voltage|voltage|brcmfmac|wlan0|firmware|error'
```

## Symptom guide

| Symptom | Most useful checks |
| --- | --- |
| Pixoo stuck near 60% | Hotspot state, `station dump`, DHCP logs, power status |
| Pixoo stuck near 80% | Emulator HTTP/MQTT logs and MQTT packet capture |
| `ip neigh` reports `FAILED` | Association state, DHCP logs, ARP capture |
| HTTP connection times out | Neighbour table, station state, HTTP capture |
| HTTP connects but responds slowly | Curl timing output, station retries/failures, emulator logs |
| Container cannot bind a port | `ss -lntp`, stop the conflicting service/container |
| Pi restarts or Wi-Fi behaves erratically | `vcgencmd get_throttled` and kernel logs |
