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

Cloud login lives only on **roborock account**. One account can feed several vacuums. The device node does not ask for an email, a code, or a session.

You only deploy once:

1. Add a **roborock vacuum** node. It asks for a **roborock device**.
2. On the device, add a **roborock account**. Sign in there (email code, password, or **Import Home Assistant session**) and click **Done**. Do not deploy yet. The sign-in is kept for the editor for 15 minutes and is also stored in the account credentials when you click Done.
3. Back on the device, **Fetch devices from account** lists the vacuums. If the device has no DUID yet and the account has one vacuum, the fields are filled in. Pick the vacuum when there are several.
4. Set the IP. The cloud list usually has no address. **Find on LAN** listens for about 8 seconds on UDP **58866** (an S7 was heard in about 6). You can also type the address from your router.
5. Click **Done** on the device, then **Deploy** once.

After that, the vacuum node does not contact Roborock's cloud. A session left on a device node by an older version is ignored. Local control keeps using the IP, DUID, and local key already stored there.

`ip`, `duid`, `localKey`, and `model` are **credentials**. They are not ordinary config fields, and they do not appear in an exported flow. Set a stable `credentialSecret` before you copy the credential store to another machine.

### Import a Home Assistant session

If Home Assistant's Roborock integration is already signed in, you can skip the email code. In `.storage/core.config_entries`, open the `roborock` entry and copy `data.user_data` (or the whole entry, so `data.base_url` and `data.username` come with it). Paste that into **Home Assistant session** on the **roborock account** node and click **Import Home Assistant session**. The node checks that `rriot` is present and stores the session in the account `userData` credential. The pasted JSON is not written to the Node-RED log or to the flow file.

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

### Maps and rooms

Whole-floor cleaning (`start`, `dock`, fan, mop) does not need a map. The device editor does not store a map and does not switch floors.

**Show maps & rooms** on the device node is a read-only list: map name, map id (`mapFlag`), and room ids. Nothing from that list is written into the node. The button never sends `load_multi_map`.

`get_multi_maps_list` is the floor list. Names are the UTF-8 text the robot sends (for example `1 этаж` and `2 этаж`) and are not percent-decoded. On some firmware each `map_info` entry also has a `rooms` array (`id`, and sometimes `iot_name`). Those ids are shown for every floor, including floors that are not loaded.

`get_room_mapping` returns segments for the **loaded map only**, as `[segmentId, cloudRoomId, tag]`. The third number is a room-type tag, not a map id. `[]` means that loaded map reported no segments. It does not mean another floor has no rooms. When a floor is not loaded and its `map_info` entry has no `rooms` array, the list says `rooms visible when this map is loaded`. Switch to that floor with a command, then read again. There is no read-only call that returns those segments on an S7 that omits `rooms` from `get_multi_maps_list`.

Room names come from the Roborock account home `rooms` list (`id` → `name`), using the account session cache or the saved account credentials. A name is attached only when `get_room_mapping` links that segment to that cloud room id. Home rooms that are not linked are ignored, so old names still on the account (for example `Главная спальня`) are not shown and cannot be used as commands. If the map list itself sent `iot_name` on a room, that name is shown next to the id. If the account session cannot be read, the ids are still listed.

```json
{"command":"map_rooms"}
{"command":"map","mapFlag":1}
{"command":"rooms","segments":[16]}
{"command":"rooms","names":["Kitchen"]}
```

`map_rooms` (alias `maps_rooms`) sets `msg.payload` to the same list the editor shows:

```json
{
  "currentMapFlag": 1,
  "maps": [
    {
      "name": "2 этаж",
      "mapFlag": 1,
      "current": true,
      "segments": [{ "segmentId": 16, "name": "Kitchen" }, { "segmentId": 17 }]
    },
    {
      "name": "1 этаж",
      "mapFlag": 2,
      "current": false,
      "segments": [],
      "note": "rooms visible when this map is loaded"
    }
  ]
}
```

`{"command":"maps"}` is unchanged: it still returns the raw `get_multi_maps_list` result.

`{"command":"map","mapFlag":1}` sends `load_multi_map` with `[1]`. A numeric string is coerced. `id` is accepted in place of `mapFlag` (`{"command":"map","id":2}`).

`{"command":"rooms","segments":[16,17],"repeat":1}` cleans those segment ids on the **loaded** map. It does not switch floors. `{"command":"rooms","names":["Kitchen"]}` (or `"name":"Kitchen"`) resolves the name only when exactly one listed segment has it. Two matches are an error. `names:["16"]` and `names:["Room 16"]` are segment 16.

### When the key stops working

`local_key` **changes** if you remove the robot from the app and add it again, or after a Wi-Fi reset / re-pair. Symptoms: commands time out, or the node logs that decrypt failed. Sign in again on the account node, fetch the device, and deploy. The IP can change too; edit that field or run **Find on LAN**.

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
| `{"command":"rooms","segments":[16,17],"repeat":1}` | `app_segment_clean` on the loaded map |
| `{"command":"rooms","names":["Kitchen"]}` | same, when that name matches one segment |
| `{"command":"map_rooms"}` | maps and room ids (`msg.payload` is the list above) |
| `{"command":"maps"}` | raw `get_multi_maps_list` |
| `{"command":"map","mapFlag":1}` | `load_multi_map` with `[1]` (switches floor) |
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
- **A floor shows no rooms.** `get_room_mapping` only describes the loaded map. Another floor says `rooms visible when this map is loaded` when `get_multi_maps_list` did not include a `rooms` array for it. Switch with `{"command":"map","mapFlag":N}`, then `{"command":"map_rooms"}`. An empty mapping on the floor that is actually loaded means that floor reported no segments.
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
2. Вход в облако только в конфиге **roborock account** (его можно добавить из поля Account у устройства). Код из почты, пароль или **Import Home Assistant session**. Для региона RU оставьте автоопределение или выберите Russia (`https://ruiot.roborock.com`). Нажмите Done. Deploy пока не нужен.
3. Вернитесь к устройству и нажмите **Fetch devices from account**. Выберите пылесос. Если DUID пустой и в аккаунте один робот, поля заполнятся сами.
4. IP часто не приходит из облака: **Find on LAN** или впишите адрес. Если UDP 58866 занят (часто Home Assistant на этой же машине), впишите IP. Done, затем один Deploy.
5. Команды: `start`, `pause`, `stop`, `dock`, `find`, `status`, либо `{command:"fan", speed:"turbo"}`. Карты: `{command:"map_rooms"}` — список этажей и id комнат, без переключения. `{command:"map", mapFlag:1}` — загрузить этаж. `{command:"rooms", segments:[16]}` — убрать комнаты по id на загруженном этаже. Имя (`names`) сработает только если оно однозначно привязано к сегменту.
6. `get_room_mapping` возвращает комнаты только загруженного этажа. Если в `get_multi_maps_list` у другого этажа нет массива `rooms`, в списке будет `rooms visible when this map is loaded`. Старые имена из облака, которые не связаны с сегментом через `get_room_mapping`, не показываются. Кнопка **Show maps & rooms** ничего не сохраняет и не переключает этаж. IP, DUID, `localKey` и model хранятся в credentials устройства, не в JSON потока.

`local_key` меняется после сброса Wi-Fi или повторного добавления робота в приложение. Тогда снова нажмите получение устройств и сделайте Deploy. Если команды висят по таймауту, проверьте что с машины Node-RED открывается TCP 58867 и что ключ не устарел.

Пакет не связан с Roborock.

## License

MIT. Copyright (c) 2026 Oleg Chumakov.
