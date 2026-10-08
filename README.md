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

Node-RED copies `credentials` into the encrypted credential store and strips them from `flows.json`. `localKey` is the credential name (camelCase). With **Auto**, the account's `pv` only decides which protocol is tried first. If that one does not answer, the other is tried, and the one that worked is remembered for the device (see [Protocol](#protocol-notes)).

### Maps and rooms

> **Name the rooms in the Roborock app first.** The robot reports a room mapping (`get_room_mapping`) only for rooms that have been named in the Roborock app at least once. Rooms that were never named come back as `[]`, and then every rooms path shows no rooms: **maps**, `{"command":"map_rooms"}`, **Show maps & rooms**, and the room picker of **clean rooms**. This is not a connection problem. On an S8 Pro Ultra with 5 unnamed rooms the mapping was `[]`, and right after naming them in the app it returned `[[16,"1881420",14],[17,"90829",6],...]` with no reconnect. Cleaning by segment and by name then worked. Name the rooms in the app, then read again (**Reload**, or a new read from the maps node).

Whole-floor cleaning (`start`, `dock`, fan, mop) does not need a map. The device editor does not store a chosen map in the flow.

**Show maps & rooms** lists map name, map id (`mapFlag`), and room ids. **Reload** on the loaded floor re-reads its rooms and does not change the robot. **Load this map** on another floor asks first, then sends `load_multi_map` with `[mapFlag]` (a number), reads that floor, and remembers the rooms. It is refused while the robot is cleaning. You can switch back to the previous floor afterward. Remembered rooms stay in the list when another floor is loaded, with `cached at` and the time. The copy is `roborock-local-map-cache.json` in the Node-RED user directory, keyed by DUID and map id. It is not part of the flow and does not need a deploy.

`get_multi_maps_list` is the floor list. Names are the UTF-8 text the robot sends (for example `1 этаж` and `2 этаж`) and are not percent-decoded. On some firmware each `map_info` entry also has a `rooms` array (`id`, and sometimes `iot_name`). Those ids are shown for every floor, including floors that are not loaded.

`get_room_mapping` returns segments for the **loaded map only**, as `[segmentId, cloudRoomId, tag]`. The third number is a room-type tag, not a map id. `[]` means that loaded map reported no segments. It does not mean another floor has no rooms. When a floor is not loaded, its `map_info` entry has no `rooms` array, and nothing has been cached for it yet, the list says `rooms visible when this map is loaded`. On an S7 that omits `rooms` from `get_multi_maps_list`, those segment ids are available only after that floor has been loaded once (from the editor button or `{"command":"map","mapFlag":N}`) and its rooms have been read.

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
      "segments": [{ "segmentId": 16, "name": "Hall" }],
      "cached": true,
      "cachedAt": "2026-10-06T12:33:00.000Z"
    }
  ]
}
```

`cached: true` means those rooms were saved the last time that floor was the loaded map. A fresh read of the loaded map updates that saved copy. `{"command":"maps"}` is unchanged: it still returns the raw `get_multi_maps_list` result.

`{"command":"map","mapFlag":1}` sends `load_multi_map` with `[1]`. A numeric string is coerced. `id` is accepted in place of `mapFlag` (`{"command":"map","id":2}`).

`{"command":"rooms","segments":[16,17],"repeat":1}` cleans those segment ids on the **loaded** map. It does not switch floors. `{"command":"rooms","names":["Kitchen"]}` (or `"name":"Kitchen"`) resolves the name only when exactly one segment on the loaded map has it, including a name stored in that map's cache. A name that exists only in another floor's cache is rejected. Two matches are an error. `names:["16"]` and `names:["Room 16"]` are segment 16.

### When the key stops working

`local_key` **changes** if you remove the robot from the app and add it again, or after a Wi-Fi reset / re-pair. Symptoms: commands time out, or the node logs that decrypt failed. Sign in again on the account node, fetch the device, and deploy. The IP can change too; edit that field or run **Find on LAN**.

## Nodes

All nodes use one **roborock device** (and share one TCP connection to the robot). The incoming message is kept on the way out, so `msg.topic` and your own properties pass through. What kind of message it is goes in `msg.kind` (`status`, `event`, `consumables`, `consumables-low`), never in `msg.topic`. Text and help are in English and Russian (Node-RED picks the editor language).

| Node | Use it for |
| --- | --- |
| **command** | One plain action chosen in a list: start, pause, stop, dock, find, spot. A string in `msg.payload` overrides it. Unknown actions are rejected instead of being sent to the robot. Right after a pause the robot can refuse `dock` with `action locked (-10003)`; the node waits about 12 seconds and tries once more (`msg.retried` is `true`). |
| **status** | Output 1: status (polled, pushed, or on demand). Output 2: events `cleaning-started`, `cleaning-finished`, `paused`, `resumed`, `error`, `error-cleared`, `low-battery`. |
| **clean rooms** | Pick rooms (and the floor) from the robot in the editor, set repeats, fan, and mop, and clean them. Switches to the chosen floor first. |
| **settings** | Fan speed and mop level. |
| **maps** | Read floors and room ids, or load a floor. |
| **consumables** | Percent left on the main brush, side brush, filter, and sensors, with a separate output for worn parts. |
| **vacuum** | The universal node. Any shorthand, any raw `{"method","params"}`. Use it for new or undocumented commands. |

### status events

A clean is in progress while the robot is cleaning or paused, or while its `in_cleaning` flag is set. The flag stays set while paused and while returning to the dock. It is 1 for a full clean and 3 while a segment clean is paused (any value above 0 counts). So `paused` and `resumed` are their own events, a resume is not a new `cleaning-started`, and `cleaning-finished` is sent only when the clean really ends (idle, charging, or returning with `in_cleaning` back at 0). When a sample has no `in_cleaning` (a pushed state change), the state alone decides, and the next poll corrects it. Set a poll interval so the end of a clean is seen even when no message arrives.

Output 1 has `msg.kind = "status"`. Output 2 has `msg.payload` and `msg.event` set to the event name, `msg.kind = "event"`, and the status in `msg.status`. Events come from the change between two samples, not from a reply to one message, so they do not carry an incoming message. The status output does: a message on the input is answered with its own `msg.topic` and properties, and several overlapping reads each answer their own message.

`low-battery` is sent once when the level drops to the set value, and again only after it has climbed above it. Events compare each sample with the previous one, so the first sample after a deploy sends none. Any message on the input reads the status now and sends it on output 1 even if nothing changed.

### clean rooms

Tick rooms after **Pick rooms from the robot** (the device must be deployed). The ids and the floor are filled in. Room ids repeat between floors, so the floor is stored with the rooms. If the floor is set and another one is loaded, the node loads it first. That is refused while the robot is cleaning, and nothing is cleaned if the floor does not switch. With the floor empty, the loaded floor is cleaned. Overrides on the message: `msg.segments`, `msg.names`, `msg.mapFlag`, `msg.repeat`, `msg.fan`, `msg.mop`. `msg.rooms` is accepted as another name for `msg.segments`. `msg.payload` names rooms only when it says so: an array (numbers are ids, text is names) or an object with `segments`, `rooms`, or `names`. A number, string, boolean, or the default inject timestamp is ignored, so it can never replace the rooms set on the node.

Loading the floor is skipped when that floor is already loaded.

### settings

`msg.fan` and `msg.mop` (or the same keys in an object payload) override the node. `silent`, `balanced`, `turbo`, `max`, `gentle`, `auto` and `off`, `low`, `medium`, `high`, or a raw number for other firmware. The values go out as one-element lists, `[103]`, the same as the `fan` and `mop` shorthand on the vacuum node.

### consumables

Service lives follow python-roborock: main brush 300 h, side brush 200 h, filter 150 h, sensors 30 h. Parts the robot does not report are skipped. Use an inject node with a repeat for a daily check.

## Vacuum node (universal)

Use this node when the dedicated ones do not cover what you need, including commands that are new or undocumented. It sends whatever `msg.payload` asks for.

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
- **No rooms at all, even on the loaded floor.** The rooms were probably never named in the Roborock app. Name them there once, then read again. See [Maps and rooms](#maps-and-rooms).
- **A floor shows no rooms.** `get_room_mapping` only describes the loaded map. Another floor says `rooms visible when this map is loaded` until **Load this map** (or `{"command":"map","mapFlag":N}` followed by `{"command":"map_rooms"}`) has read it once. Later lists show that saved copy with `cached at`. Loading a map is refused while the robot is cleaning. **Reload** on the loaded floor re-reads rooms without switching. An empty mapping on the floor that is actually loaded means that floor reported no segments.
- **`No CONNACK for 1.0` or `No CONNACK for L01`.** Some firmware reports `pv` 1.0 in the cloud but answers only L01 on the LAN (an S8 Pro Ultra, `roborock.vacuum.a51`, does), and many older ones answer only 1.0. Leave protocol on Auto: it tries the account's version, then the other, and remembers the one that worked, so only the first connect pays for the failed hello. A forced protocol is never second-guessed and reports this error when the firmware does not speak it.
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

Tests cover the dedicated nodes against a fake vacuum, the status events, the 1.0 and L01 framing against vectors from python-roborock, UDP discovery packets, the Hawk header used for home data, a fake cloud, and a fake vacuum including the Node-RED node. Nothing in CI contacts a real robot or Roborock.

GitHub Actions runs lint and tests on Node 18, 20, and 22. Publishing is a separate workflow that runs when a GitHub Release is published. It authenticates to npm with trusted publishing (OIDC), not an `NPM_TOKEN` secret. See [RELEASING.md](RELEASING.md).

## Protocol notes

Local control is a length-prefixed TCP session on port 58867:

- **CONNECT / CONNACK** negotiate the session. The implementation sends the app-style connect (protocol 0, 4-byte keepalive, no CRC) and, if the robot stays silent, the python-roborock hello. Auto tries the version that worked last time for this device, else the account protocol `pv`, else 1.0, and then the other version. The working version is kept in memory and in `roborock-local-protocol-cache.json` in the Node-RED user directory, keyed by DUID. The file never holds the key and is not part of the flow.
- **PUBLISH** (protocol 4) carries AES-encrypted JSON. Version `1.0` is AES-128-ECB with `MD5(scrambled timestamp + local_key + salt)`. Version `L01` is AES-256-GCM. A CRC32 covers the frame.
- The JSON envelope is `{"dps":{"101":"<rpc>"},"t":<unix>}` and the reply comes back on dps `102` with a matching `id`.

Map downloads, B01 (some Q-series) command translation, and MQTT cloud control are not implemented. Raw `method` / `params` still go out as a 1.0 or L01 publish if the robot is already on that session.

The protocol behavior was reimplemented from public documentation and the Apache-2.0 python-roborock sources. This package does not ship that code.

## По-русски

Неофициальные ноды Node-RED для управления роботом Roborock **по локальной сети** (TCP 58867). Облако нужно только чтобы один раз забрать `local_key`.

1. Поставьте пакет, перезапустите Node-RED.
2. Вход в облако только в конфиге **roborock account** (его можно добавить из поля Account у устройства). Код из почты, пароль или **Import Home Assistant session**. Для региона RU оставьте автоопределение или выберите Russia (`https://ruiot.roborock.com`). Нажмите Done. Deploy пока не нужен.
3. Вернитесь к устройству и нажмите **Fetch devices from account**. Выберите пылесос. Если DUID пустой и в аккаунте один робот, поля заполнятся сами.
4. IP часто не приходит из облака: **Find on LAN** или впишите адрес. Если UDP 58866 занят (часто Home Assistant на этой же машине), впишите IP. Done, затем один Deploy.
5. Команды: `start`, `pause`, `stop`, `dock`, `find`, `status`, либо `{command:"fan", speed:"turbo"}`. Карты: `{command:"map_rooms"}` — список этажей и id комнат, без переключения. `{command:"map", mapFlag:1}` — загрузить этаж. `{command:"rooms", segments:[16]}` — убрать комнаты по id на загруженном этаже. Имя (`names`) сработает только если оно однозначно привязано к сегменту.
6. `get_room_mapping` возвращает комнаты только загруженного этажа. **Reload** у загруженного этажа перечитывает их и не переключает робота. **Load this map** у другого этажа спрашивает подтверждение, загружает этаж и запоминает комнаты (отказ, если робот сейчас убирает). Потом их видно с пометкой `cached at`, даже когда загружен другой этаж. Старые имена из облака, которые не связаны с сегментом через `get_room_mapping`, не показываются. IP, DUID, `localKey` и model хранятся в credentials устройства, не в JSON потока.

`local_key` меняется после сброса Wi-Fi или повторного добавления робота в приложение. Тогда снова нажмите получение устройств и сделайте Deploy. Если команды висят по таймауту, проверьте что с машины Node-RED открывается TCP 58867 и что ключ не устарел.

Пакет не связан с Roborock.

## License

MIT. Copyright (c) 2026 Oleg Chumakov.
