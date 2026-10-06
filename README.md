# node-red-contrib-roborock-local

Node-RED nodes that drive a Roborock robot vacuum over the **local network**. Day-to-day commands stay on your LAN (TCP port **58867**). The cloud is used only when you ask the editor to fetch the device key from your Roborock account.

This package is **unofficial** and is **not affiliated with Roborock**.

It is aimed at robots that speak Roborock's own local protocol rather than classic Xiaomi miIO. A Roborock **S7** (`roborock.vacuum.a15`, firmware 02.16.12) keeps TCP 58867 open and does **not** answer miIO UDP 54321, so python-miio-style nodes never see it. Home Assistant's Roborock integration talks to that S7 through [`python-roborock`](https://github.com/Python-roborock/python-roborock); this package follows that protocol (message framing, 1.0 / L01, AES, CRC, hello, request ids, and the usual app commands).

Requires **Node.js 18 or newer** (Node-RED 4, which this was exercised against, needs it; `fetch` is used for the one-time cloud login) and **Node-RED 3 or newer**.

## Install

From the Node-RED palette, search for `node-red-contrib-roborock-local`, or from `~/.node-red`:

```bash
npm install node-red-contrib-roborock-local
```

Restart Node-RED. Set a stable `credentialSecret` in `settings.js` **before** you deploy keys if you move the flows file between machines. Node-RED encrypts credentials with that secret; without a fixed secret, a copied flows file cannot decrypt `local_key`.

## Fetch the device key

You need three values the robot already has: its **IP**, **DUID**, and **local_key**. The key is a secret. It is stored in Node-RED **credentials**, not in the exported flow.

### In the editor

1. Drag in a **roborock device** config (the vacuum node asks for one). Optionally add a **roborock account** if several vacuums share one login.
2. Enter the email address of the Roborock app account.
3. Leave region on **Auto-detect**, or pick one. Russia is `https://ruiot.roborock.com`, Europe `euiot`, United States `usiot`, China `cniot`.
4. Click **Send code**, then enter the code from the email and **Log in with code**. Password login is there for older accounts; many newer accounts only accept the code. Or paste an existing session (see below) and click **Import session**.
5. Click your vacuum in the list. That fills DUID, model, firmware, `local_key`, and protocol version `pv` when the account has one.
6. Set the IP. The cloud list usually has no address. **Find on LAN** listens for about 8 seconds on UDP **58866** (an S7 was heard in about 6). You can also type the address from your router.
7. Deploy.

After that, the vacuum node does not contact Roborock's cloud.

`ip`, `duid`, `localKey`, and `model` are **credentials**. They are not ordinary config fields, and they do not appear in an exported flow. Set a stable `credentialSecret` before you copy the credential store to another machine.

### Import a Home Assistant session

If Home Assistant's Roborock integration is already signed in, you can skip the email code. In `.storage/core.config_entries`, open the `roborock` entry and copy `data.user_data` (or the whole entry, so `data.base_url` and `data.username` come with it). Paste that into **Existing session** on the account or device config and click **Import session**. The node checks that `rriot` is present, loads the device list, and stores the session in the `userData` credential. The pasted JSON is not written to the Node-RED log or to the flow file.

### Deploying with the Admin API

`POST /flows` with the default header `Node-RED-API-Version: v1` (or with that header omitted) takes a **raw JSON array**. Credentials are not separate config properties. Put them on the device node:

```json
[
  {
    "id": "device1",
    "type": "roborock-device",
    "name": "S7",
    "protocol": "auto",
    "pv": "1.0",
    "rooms": "[]",
    "credentials": {
      "ip": "192.168.1.20",
      "duid": "YOUR_DUID",
      "localKey": "YOUR_LOCAL_KEY",
      "model": "roborock.vacuum.a15"
    }
  }
]
```

Node-RED copies `credentials` into the encrypted credential store and strips them from `flows.json`. `localKey` is the credential name (camelCase). A `pv` of `1.0` makes **Auto** skip the L01 hello.

### Maps and numbered rooms

**Read maps** calls `get_multi_maps_list` and `get_room_mapping` for the map that is currently loaded. Map names come from the robot (floor names such as `1 этаж`). Segments are stored as **Room 16**, **Room 17**, and so on. **Load** sends `load_multi_map` and switches the robot onto that floor, then reads segments again.

Map names are the UTF-8 text the robot sends. They are kept as-is (a name that happens to contain `%` is not percent-decoded).

Rooms that were never given names in the app often produce an empty `get_room_mapping` for the loaded map. The editor then says no segments were returned for this map, and that you can enter numbered segment ids by hand or load another map and read again. If `get_room_mapping` itself fails, the map list is still returned, with `mappingError` and the same kind of warning. Type segment ids yourself, one per line (`16` or `16 Hall`). Cloud home entries such as old default room labels are not segment ids and are not used. `lab_status` and `unsave_map_flag` are status fields; they are not treated as a statement that the map has no room splits.

```json
{"command":"rooms","segments":[16]}
{"command":"rooms","names":["Room 16"]}
{"command":"maps"}
{"command":"map","mapFlag":1}
```

`names:["16"]` is segment 16 even before you press Read maps.

### When the key stops working

`local_key` **changes** if you remove the robot from the app and add it again, or after a Wi-Fi reset / re-pair. Symptoms: commands time out, or the node logs that decrypt failed. Open the device config, fetch the device again (sign in if the saved session expired), deploy. The IP can change too; edit that field or run **Find on LAN** without fetching a new key.

## Vacuum node

| Input `msg.payload` | What it sends |
| --- | --- |
| `start` / `resume` | `app_start` |
| `pause` | `app_pause` |
| `stop` | `app_stop` |
| `dock`, `home`, `charge` | `app_charge` |
| `find` | `find_me` |
| `spot` | `app_spot` |
| `status` | `get_status` |
| `{"command":"fan","speed":"turbo"}` | `set_custom_mode` |
| `{"command":"mop","intensity":"low"}` | `set_water_box_custom_mode` |
| `{"command":"rooms","segments":[16,17],"repeat":1}` | `app_segment_clean` |
| `{"command":"rooms","names":["Room 16"]}` | segment 16 (`16` or `Room 16` also work) |
| `{"command":"maps"}` | `get_multi_maps_list` |
| `{"command":"map","mapFlag":1}` | `load_multi_map` (switches floor) |
| `{"command":"zone","zones":[[x1,y1,x2,y2,1]]}` | `app_zoned_clean` |
| `{"method":"get_consumable","params":[]}` | that method, unchanged |

Fan names `silent`, `balanced`, `turbo`, `max`, `gentle`, and `auto` map to S7-style custom modes **101–106**. Older firmware sometimes wants **38 / 60 / 77 / 90**. Pass a number when the name is wrong for your firmware: `{"command":"fan","speed":60}`.

**Output 1** is the command result (`msg.payload`), plus `msg.method` and `msg.status` when a status has been seen.

**Output 2** is status. The first sample is sent after connect; with *Emit status only when it changes* checked, later messages wait for a change. `pollInterval` is in seconds; `0` disables the timer (a status is still read once so the node status line can show battery).

`msg.payload.stateName` is text: `cleaning`, `returning`, `charging`, `idle`, `paused`, `error`, `spot cleaning`, `segment cleaning`, and the other states the app uses. `errorName` maps the numeric error (`main brush jammed`, `lidar blocked`, …). `cleanAreaM2` is `clean_area / 1e6`.

The node status line shows the same idea, for example `charging 87%` or `cleaning 42%`.

One TCP connection is shared by every vacuum node that points at the same device. It reconnects with backoff, matches RPC ids, sends a keepalive, and closes the socket on redeploy.

## Check a real robot

These commands are for a machine on the same LAN as the vacuum. They are not run by CI.

```bash
ROBOROCK_LOCAL_KEY=YOUR_LOCAL_KEY npx roborock-local-test --ip 192.168.1.20 --duid YOUR_DUID
printf '%s\n' "$ROBOROCK_LOCAL_KEY" | npx roborock-local-test --ip 192.168.1.20 --command get_multi_maps_list
npx roborock-local-test --ip 192.168.1.20 --command start --allow-write
node scripts/local-test.js --ip 192.168.1.20 --protocol 1.0 --pv 1.0
```

The local key is taken from `ROBOROCK_LOCAL_KEY`, from the first line of stdin when stdin is not a terminal, or from a prompt. `--key` still works and prints a warning, because the value is stored in shell history. Do not put the key on the command line if you can avoid it. The process never prints the key back.

`get_status` is the default. Other getters (`get_consumable`, `get_multi_maps_list`, `get_room_mapping`, and any other `get_*` method) are allowed too. `start`, `load_multi_map`, and every other command are refused unless you pass `--allow-write`. That limit is only on this CLI. The vacuum node still accepts `start`, `pause`, and map loads. A successful run prints JSON with `protocol` (`1.0` or `L01`), `hello` (`app` or `python`), and the result.

Cloud login, which prints DUIDs and local keys (treat the output as a secret):

```bash
npx roborock-cloud-login --email you@example.com --region ru
node scripts/cloud-login.js --email you@example.com --region ru --json
```

With neither `--code` nor `--password`, it sends a code and asks for it on the terminal.

## Troubleshooting

- **Nothing on port 54321.** Expected on current S7 firmware. This node uses TCP 58867 only.
- **Handshake timeout.** The Node-RED host cannot open TCP 58867 to the robot (VLAN, guest Wi-Fi, firewall). Confirm with `nc -vz <ip> 58867`.
- **Decrypt failed / RPC timeout after a successful socket connect.** The `local_key` does not match this robot anymore. Fetch it again.
- **Find on LAN hears nothing.** The robot broadcasts on UDP 58866 only now and then. The button listens for about 8 seconds. Type the IP if nothing arrives. Discovery is optional.
- **UDP 58866 already in use (EADDRINUSE).** Another program on this same machine, often Home Assistant's Roborock integration, already bound that port. Discovery works when Home Assistant is not on this host. Type the IP, or stop the other listener and try again.
- **No segments returned for the current map.** `get_room_mapping` only lists the loaded map, and an S7 with numbered, unnamed rooms can return `[]` even though `get_multi_maps_list` has floor names. Load the other map, or type segment ids. If the mapping call fails, the map names are still shown and the warning includes `mappingError`. Do not treat cloud home room names as segment ids.
- **`No CONNACK for L01`.** This firmware speaks protocol 1.0. Leave protocol on Auto and keep `pv` at `1.0` (filled from the account), or set the protocol dropdown to 1.0. Auto then does not wait on an L01 hello. Forced L01 still reports this error.
- **Auto-detect region fails.** Pick Russia / Europe / US / China. The URL must be `https://*.roborock.com`.
- **Code 2018.** The email code was wrong or expired. Send another.
- **Code 3009 / 3006.** Open the Roborock app and accept the user agreement. Mi Home accounts are not Roborock accounts.
- **Code 9002.** Too many code emails. Wait before trying again.
- **Imported flow has an empty device.** Credentials are not part of the flow JSON. Enter the key again on the new machine (and use the same `credentialSecret` if you copied the credential store).

## Development

```bash
npm ci
npm test
npm run lint
```

Tests cover the 1.0 and L01 framing against vectors from python-roborock, UDP discovery packets, the Hawk header used for home data, a fake cloud, and a fake vacuum including the Node-RED node. Nothing in CI contacts a real robot or Roborock.

GitHub Actions runs lint and tests on Node 18, 20, and 22. Publishing is a separate workflow that runs when a GitHub Release is published. It authenticates to npm with trusted publishing (OIDC), not an `NPM_TOKEN` secret. See [RELEASING.md](RELEASING.md).

## Protocol notes

Local control is a length-prefixed TCP session on port 58867:

- **CONNECT / CONNACK** negotiate the session. The implementation sends the app-style connect (protocol 0, 4-byte keepalive, no CRC) and, if the robot stays silent, the python-roborock hello. Auto tries 1.0 and then L01, except when the account protocol `pv` is `1.0`, in which case L01 is not attempted.
- **PUBLISH** (protocol 4) carries AES-encrypted JSON. Version `1.0` is AES-128-ECB with `MD5(scrambled timestamp + local_key + salt)`. Version `L01` is AES-256-GCM. A CRC32 covers the frame.
- The JSON envelope is `{"dps":{"101":"<rpc>"},"t":<unix>}` and the reply comes back on dps `102` with a matching `id`.

Map downloads, B01 (some Q-series) command translation, and MQTT cloud control are not in 0.1.0. Raw `method` / `params` still go out as a 1.0 or L01 publish if the robot is already on that session.

The protocol behavior was reimplemented from public documentation and the Apache-2.0 python-roborock sources. This package does not ship that code.

## По-русски

Неофициальные ноды Node-RED для управления роботом Roborock **по локальной сети** (TCP 58867). Облако нужно только чтобы один раз забрать `local_key`.

1. Поставьте пакет, перезапустите Node-RED.
2. В конфиге **roborock device** укажите почту аккаунта Roborock. Для региона RU оставьте автоопределение или выберите Russia (`https://ruiot.roborock.com`).
3. **Send code**, введите код из письма, войдите. Выберите пылесос.
4. IP часто не приходит из облака: нажмите **Find on LAN** или впишите адрес вручную. Если UDP 58866 занят (часто Home Assistant на этой же машине), впишите IP. Deploy.
5. Команды: `start`, `pause`, `stop`, `dock`, `find`, `status`, либо объект `{command:"fan", speed:"turbo"}` и `{command:"rooms", segments:[16]}`. Карты этажей: **Read maps** (`get_multi_maps_list`). Комнаты без имён — это номера сегментов, «Room 16». Имена комнат из облака не используются.
6. Сессию из Home Assistant можно вставить как `user_data` (кнопка **Import session**) вместо кода из почты. IP, DUID, `localKey` и model хранятся в credentials, не в JSON потока.

`local_key` меняется после сброса Wi-Fi или повторного добавления робота в приложение. Тогда снова нажмите получение устройств и сделайте Deploy. Если команды висят по таймауту, проверьте что с машины Node-RED открывается TCP 58867 и что ключ не устарел.

Пакет не связан с Roborock.

## License

MIT. Copyright (c) 2026 Oleg Chumakov.
