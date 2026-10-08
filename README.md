# node-red-contrib-roborock-local

Node-RED nodes for Roborock robot vacuums over your **local network**. Commands and status go straight to the robot over Roborock's local TCP protocol (port **58867**, versions 1.0 and L01). The cloud is used once, only to fetch the device key.

This package is **unofficial** and is **not affiliated with Roborock**.

Requires **Node.js 18 or newer** and **Node-RED 3 or newer**.

## Install

From the Node-RED palette, search for `node-red-contrib-roborock-local`, or from `~/.node-red`:

```bash
npm install node-red-contrib-roborock-local
```

Restart Node-RED. If you move the flows file between machines, set a fixed `credentialSecret` in `settings.js` **before** you deploy keys. Node-RED encrypts credentials with it, and a copied flows file cannot decrypt the local key without it.

## Nodes

Start with the dedicated nodes. Each does one job, and all of them share one **roborock device** and one TCP connection to the robot.

| Node | Use it for |
| --- | --- |
| **command** | One plain action: start, pause, stop, dock, find, spot. |
| **status** | Status (polled, pushed or on demand) and events such as `cleaning-started` or `low-battery`. |
| **clean rooms** | Pick rooms (and the floor) from the robot in the editor and clean them, with repeats, fan and mop. |
| **settings** | Fan speed and mop level. |
| **maps** | Read floors and room ids, or load a floor. |
| **consumables** | Percent left on the brushes, filter and sensors, with a separate output for worn parts. |
| **vacuum** | The universal, advanced node: any shorthand and any raw `{"method","params"}`. Use it for new or undocumented commands. |

Two config nodes hold the setup: **roborock device** (IP, DUID, local key, protocol) and **roborock account** (cloud sign-in used to fetch the key).

Every node keeps the incoming message on its output, so `msg.topic` and your own properties pass through. What kind of message it is goes in `msg.kind` (`status`, `event`, `consumables`, `consumables-low`), never in `msg.topic`. Editor text and help are in English and Russian.

## Set up a device

You need three values the robot already has: its **IP**, **DUID** and **local key**. The key is a secret. It is stored in Node-RED **credentials**, not in the exported flow.

1. Add any Roborock node (for example **command**). It asks for a **roborock device**.
2. On the device, add a **roborock account**. Sign in there (email code, password, or **Import Home Assistant session**) and click **Done**. Do not deploy yet.
3. Back on the device, **Fetch devices from account** lists the vacuums. With one vacuum on the account and an empty DUID, the fields are filled in. Otherwise pick the vacuum.
4. Set the IP. The cloud list usually has no address. **Find on LAN** listens for about 8 seconds on UDP **58866**. If nothing is heard, type the IP from your router. If the port is busy, another app on this host is using it.
5. Click **Done** on the device, then **Deploy** once.

After that the nodes do not contact Roborock's cloud.

`ip`, `duid`, `localKey` and `model` are credentials. They are not ordinary config fields and do not appear in an exported flow.

You can also enter IP, DUID and key by hand (for example from `roborock-cloud-login`, see [below](#check-a-real-robot)). An account is then optional.

### Import a Home Assistant session

If Home Assistant's Roborock integration is already signed in, you can skip the email code. In `.storage/core.config_entries`, open the `roborock` entry and copy `data.user_data` (or the whole entry, so `data.base_url` and `data.username` come with it). Paste it into **Home Assistant session** on the **roborock account** node and click **Import Home Assistant session**. The node checks that `rriot` is present and stores the session in the account credentials. The pasted JSON is not logged or written to the flow.

### Deploying with the Admin API

`POST /flows` with the default `Node-RED-API-Version: v1` takes a raw JSON array. Put the secrets in the device node's `credentials` object:

```json
[
  {
    "id": "device1",
    "type": "roborock-device",
    "name": "Vacuum",
    "protocol": "auto",
    "credentials": {
      "ip": "192.168.1.20",
      "duid": "YOUR_DUID",
      "localKey": "YOUR_LOCAL_KEY",
      "model": "roborock.vacuum.xxx"
    }
  }
]
```

Node-RED moves `credentials` into its encrypted store and strips them from `flows.json`.

### Protocol

The device's **Protocol** is **Auto (recommended)**, **1.0** or **L01**. Auto tries the version that worked last time, else the one the cloud reports, else 1.0, and then the other one. It remembers the working version per device, so only the first connect pays for a failed hello. Some models, such as the S8 Pro Ultra, answer only L01 on the LAN even when the cloud says 1.0. Auto handles that. A fixed 1.0 or L01 is never second-guessed and fails with `No CONNACK` if the robot does not speak it.

### When the key stops working

The local key changes if you remove the robot from the app and add it again, or after a Wi-Fi reset. Commands then time out, or the node reports `decrypt failed`. Sign in again on the account node, fetch the device and deploy. The IP can change too: edit it or run **Find on LAN**.

## command

Sends one plain action chosen in a list: start, pause, stop, dock, find, spot. A string in `msg.payload` replaces it. Unknown actions are rejected instead of being sent to the robot.

Right after a pause the robot can refuse `dock` with `action locked (-10003)`. The node waits about 12 seconds and tries once more, and sets `msg.retried` to `true`.

## status

Output 1 is the status, with `msg.kind = "status"`. Output 2 is an event: `msg.payload` and `msg.event` are the event name, `msg.kind = "event"`, and `msg.status` is the status. Events: `cleaning-started`, `cleaning-finished`, `paused`, `resumed`, `error`, `error-cleared`, `low-battery`.

- Any message on the input reads the status now and sends it on output 1, even if nothing changed. It is answered with its own `msg.topic` and properties; overlapping reads each answer their own message.
- Events come from the change between two samples, so they carry no incoming message, and the first sample after a deploy sends none.
- A clean is in progress while the robot is cleaning or paused, or while its `in_cleaning` flag is above 0 (1 for a full clean, 3 while a segment clean is paused). `paused` and `resumed` are their own events, and a resume is not a new `cleaning-started`.
- `cleaning-finished` is sent when `in_cleaning` drops to 0. The robot clears it as soon as it is sent home, or starts heading back by itself, so the event fires when the return to the dock starts, not when the robot has docked or is charging.
- `low-battery` is sent once when the level drops to the set value, and again only after it has climbed above it.
- When a sample has no `in_cleaning` (a pushed state change), the state alone decides and the next poll corrects it. Set a poll interval so the end of a clean is seen even when no message arrives.

## clean rooms

Tick rooms after **Pick rooms from the robot** (the device must be deployed). The ids and the floor are filled in.

- Room ids repeat between floors, so the floor is stored with the rooms. If the floor is set and another one is loaded, the node loads it first. That is refused while the robot is cleaning, and nothing is cleaned if the floor does not switch. A floor that is already loaded is not reloaded. With the floor empty, the loaded floor is cleaned.
- Overrides on the message: `msg.segments` (or `msg.rooms`), `msg.names`, `msg.mapFlag`, `msg.repeat`, `msg.fan`, `msg.mop`.
- `msg.payload` names rooms only when it says so: an array (numbers are ids, text is names) or an object with `segments`, `rooms` or `names`. A number, string or boolean, such as the default inject timestamp, is ignored.

See [Maps and rooms](#maps-and-rooms) for how rooms are found.

## settings

`msg.fan` and `msg.mop` (or the same keys in an object payload) override the node. Fan: `silent`, `balanced`, `turbo`, `max`, `gentle`, `auto`. Mop: `off`, `low`, `medium`, `high`. A number is sent as it is. Named fan speeds are custom modes 101-106 (most current models); some older firmware uses other numbers, so pass a number. Values go out as one-element lists, for example `[103]`.

## maps

Action **read** lists floors and room ids without changing the robot. Action **load** sends `load_multi_map`, reads the new floor's rooms and keeps them; it is refused while the robot is cleaning. Loading a floor that is already loaded only re-reads it. `msg.payload` is the same list as `map_rooms` below.

## consumables

Reports percent left per wear part. Service lives: main brush 300 h, side brush 200 h, filter 150 h, sensors 30 h. Parts the robot does not report are skipped. Output 1 has every part, output 2 only the parts at or below the warning level. Use an inject node with a repeat for a daily check.

## vacuum (universal)

Sends whatever `msg.payload` asks for, so it also covers commands that are new or undocumented. When the payload is empty, the Command on the node is used.

| Input `msg.payload` | What it sends |
| --- | --- |
| `start` / `resume` | `app_start` |
| `pause` | `app_pause` |
| `stop` | `app_stop` |
| `dock`, `home`, `charge` | `app_charge` |
| `find` | `find_me` |
| `spot` | `app_spot` |
| `status` | `get_status` |
| `{"command":"fan","speed":"turbo"}` | `set_custom_mode` with `[103]` |
| `{"command":"mop","intensity":"low"}` | `set_water_box_custom_mode` |
| `{"command":"rooms","segments":[16,17],"repeat":1}` | `app_segment_clean` on the loaded map |
| `{"command":"rooms","names":["Kitchen"]}` | same, when the name matches one room |
| `{"command":"map_rooms"}` | maps and room ids |
| `{"command":"maps"}` | raw `get_multi_maps_list` |
| `{"command":"map","mapFlag":1}` | `load_multi_map` with `[1]` (switches floor) |
| `{"command":"zone","zones":[[x1,y1,x2,y2,1]]}` | `app_zoned_clean` |
| `{"method":"get_consumable","params":[]}` | that method, unchanged |

Fan names `silent`, `balanced`, `turbo`, `max`, `gentle` and `auto` are custom modes **101-106** (most current models). Some older firmware uses other numbers: pass one, for example `{"command":"fan","speed":60}`.

**Output 1** is the result: `msg.payload`, plus `msg.method` and `msg.status` when a status has been seen. **Output 2** is the status, sent after connect, on each poll and when the robot pushes a change. `pollInterval` is in seconds; `0` turns the timer off. `msg.payload.stateName` is text such as `cleaning`, `returning`, `charging`, `idle`, `paused` or `error`; `errorName` names the error code; `cleanAreaM2` is the cleaned area in square metres.

The node status line shows the state and battery, for example `charging 87%`.

All nodes on one device share one TCP connection. It reconnects with backoff, matches request ids, sends a keepalive (a PING at least every half of the 10 s keepalive it announces), and closes on redeploy.

## Maps and rooms

> **Name the rooms in the Roborock app first.** The robot reports a room mapping only for rooms that have been named in the Roborock app at least once. Until then it reports none, and every rooms path shows no rooms: **maps**, `map_rooms`, **Show maps & rooms** and the room picker of **clean rooms**. This is not a connection problem. Name the rooms in the app, then read again (**Reload**, or a new read from the maps node).

Whole-floor cleaning (start, dock, fan, mop) does not need a map.

**Show maps & rooms** on the device lists each floor with its name, map id (`mapFlag`) and room ids.

- **Reload** on the loaded floor re-reads its rooms and does not change the robot.
- **Load this map** on another floor asks first, then loads that floor, reads its rooms and remembers them. It is refused while the robot is cleaning. You can switch back to the previous floor afterward.
- The robot describes rooms only for the **loaded** floor. Rooms of other floors come from the copy saved when that floor was last loaded (`cached at` and the time), or are listed if the map list carries them. Otherwise the line says `rooms visible when this map is loaded`: load that floor once.
- The saved copy is `roborock-local-map-cache.json` in the Node-RED user directory, keyed by DUID and map id. It is not part of the flow and needs no deploy.
- A room name is shown only when the robot's mapping links that room to a room in your Roborock account home (or the map list names it). Old names still on the account are not shown and cannot be used as commands.

`{"command":"map_rooms"}` (alias `maps_rooms`) and the **maps** node return:

```json
{
  "currentMapFlag": 1,
  "maps": [
    {
      "name": "Upper floor",
      "mapFlag": 1,
      "current": true,
      "segments": [{ "segmentId": 16, "name": "Kitchen" }, { "segmentId": 17 }]
    },
    {
      "name": "Ground floor",
      "mapFlag": 2,
      "current": false,
      "segments": [{ "segmentId": 16, "name": "Hall" }],
      "cached": true,
      "cachedAt": "2026-10-06T12:33:00.000Z"
    }
  ]
}
```

Commands on the **vacuum** node:

```json
{"command":"map","mapFlag":1}
{"command":"rooms","segments":[16]}
{"command":"rooms","names":["Kitchen"]}
```

`map` loads that floor (`id` works in place of `mapFlag`). `rooms` cleans on the **loaded** floor and does not switch floors. A name resolves only when exactly one room on the loaded floor has it; two matches are an error. `names:["16"]` and `names:["Room 16"]` mean room 16.

## Check a real robot

These commands are for a machine on the same LAN as the vacuum. CI does not run them.

```bash
ROBOROCK_LOCAL_KEY=YOUR_LOCAL_KEY npx roborock-local-test --ip 192.168.1.20 --duid YOUR_DUID
printf '%s\n' "$ROBOROCK_LOCAL_KEY" | npx roborock-local-test --ip 192.168.1.20 --command get_multi_maps_list
npx roborock-local-test --ip 192.168.1.20 --command start --allow-write
node scripts/local-test.js --ip 192.168.1.20 --protocol 1.0 --pv 1.0
```

The key is read from `ROBOROCK_LOCAL_KEY`, from the first line of stdin when stdin is not a terminal, or from a prompt. `--key` still works and prints a warning, because the value ends up in shell history. The key is never printed back.

`get_status` is the default. Other `get_*` methods are allowed too. `start`, `load_multi_map` and every other command are refused unless you pass `--allow-write`. That limit is only on this CLI. A successful run prints JSON with `protocol` (`1.0` or `L01`), `hello` (`app` or `python`) and the result.

Cloud login, which prints DUIDs and local keys (treat the output as a secret):

```bash
npx roborock-cloud-login --email you@example.com --region eu
node scripts/cloud-login.js --email you@example.com --region eu --json
```

With neither `--code` nor `--password`, it sends a code and asks for it on the terminal.

## Troubleshooting

- **Handshake timeout.** The Node-RED host cannot open TCP 58867 to the robot (VLAN, guest Wi-Fi, firewall). Check with `nc -vz <ip> 58867`.
- **`No CONNACK for 1.0` or `No CONNACK for L01`.** The robot does not speak the version that was tried. Leave Protocol on Auto, which tries both and remembers the one that works. A fixed protocol reports this error when the robot does not speak it.
- **Decrypt failed, or RPC timeout after the socket connected.** The local key does not match this robot. Fetch it again.
- **Find on LAN hears nothing.** The robot announces itself only now and then, and the button listens for about 8 seconds. Try again or type the IP.
- **UDP 58866 already in use (EADDRINUSE).** Another app on this host, often Home Assistant's Roborock integration, uses the port. Type the IP, or stop the other listener.
- **No rooms at all, even on the loaded floor.** The rooms were never named in the Roborock app. Name them there once, then read again. See [Maps and rooms](#maps-and-rooms).
- **A floor shows no rooms.** Only the loaded floor reports rooms. Load that floor once (**Load this map**, or `{"command":"map","mapFlag":N}` followed by `{"command":"map_rooms"}`); later lists show the saved copy. Loading is refused while the robot is cleaning.
- **Region auto-detect fails.** Pick Russia, Europe, US or China. The URL must be `https://*.roborock.com`.
- **Code 2018.** The email code was wrong or expired. Send another.
- **Code 3009 / 3006.** Open the Roborock app and accept the user agreement. Mi Home accounts are not Roborock accounts.
- **Code 9002.** Too many code emails. Wait before trying again.
- **An imported flow has an empty device.** Credentials are not part of the flow JSON. Enter the key again on the new machine, and use the same `credentialSecret` if you copied the credential store.

## Development

```bash
npm ci
npm test
npm run lint
```

Tests cover the dedicated nodes and the vacuum node against a fake vacuum, the status events, the 1.0 and L01 framing against vectors from python-roborock, UDP discovery packets, the Hawk header used for home data, and a fake cloud. Nothing in CI contacts a real robot or Roborock.

GitHub Actions runs lint and tests on Node 18, 20 and 22. Publishing is a separate workflow that runs when a GitHub Release is published. It authenticates to npm with trusted publishing (OIDC), not an `NPM_TOKEN` secret. See [RELEASING.md](RELEASING.md).

## Protocol notes

Local control is a length-prefixed TCP session on port 58867:

- **CONNECT / CONNACK** open the session. The client sends the app-style connect (protocol 0, 4-byte keepalive, no CRC) and, if the robot stays silent, the python-roborock hello. The working protocol version is kept in memory and in `roborock-local-protocol-cache.json` in the Node-RED user directory, keyed by DUID. The file never holds the key and is not part of the flow.
- **PUBLISH** (protocol 4) carries AES-encrypted JSON. Version `1.0` is AES-128-ECB with `MD5(scrambled timestamp + local_key + salt)`. Version `L01` is AES-256-GCM. A CRC32 covers the frame.
- The JSON envelope is `{"dps":{"101":"<rpc>"},"t":<unix>}` and the reply comes back on dps `102` with a matching `id`.

The protocol was reimplemented from public documentation and the Apache-2.0 [python-roborock](https://github.com/Python-roborock/python-roborock) sources. This package does not ship that code.

## По-русски

Неофициальные ноды Node-RED для управления роботом-пылесосом Roborock **по локальной сети**. Команды и статус идут напрямую роботу по локальному TCP-протоколу Roborock (порт 58867, версии 1.0 и L01). Облако нужно один раз, только чтобы получить ключ устройства.

Нужны Node.js 18+ и Node-RED 3+. Пакет не связан с Roborock. Текст и справка в редакторе есть на русском и английском.

### Ноды

Начните со специальных нод: каждая делает одно дело, и все они используют одно **roborock device** и одно TCP-соединение с роботом.

| Нода | Для чего |
| --- | --- |
| **command** | Одно простое действие: start, pause, stop, dock, find, spot. |
| **status** | Статус (по опросу, по событию или по запросу) и события: `cleaning-started`, `low-battery` и другие. |
| **clean rooms** | Выбрать комнаты (и этаж) с робота в редакторе и убрать их; повторы, мощность, мойка. |
| **settings** | Мощность всасывания и интенсивность мойки. |
| **maps** | Прочитать этажи и id комнат или загрузить этаж. |
| **consumables** | Остаток ресурса щёток, фильтра и датчиков; отдельный выход для изношенных деталей. |
| **vacuum** | Универсальная нода для продвинутых: любое сокращение и любой «сырой» `{"method","params"}`. Для новых и недокументированных команд. |

Настройки лежат в двух конфиг-нодах: **roborock device** (IP, DUID, локальный ключ, протокол) и **roborock account** (вход в облако, чтобы получить ключ). Каждая нода сохраняет входящее сообщение: `msg.topic` и ваши свойства проходят дальше. Тип сообщения лежит в `msg.kind` (`status`, `event`, `consumables`, `consumables-low`), а не в `msg.topic`.

### Настройка устройства

1. Добавьте любую ноду Roborock (например, **command**) и создайте **roborock device**.
2. В устройстве добавьте **roborock account** и войдите: код из почты, пароль или **Импортировать сессию Home Assistant**. Для региона RU оставьте автоопределение или выберите Россию (`https://ruiot.roborock.com`). Нажмите Done. Deploy пока не нужен.
3. Вернитесь к устройству и нажмите **Получить устройства из аккаунта**. Выберите пылесос. Если в аккаунте один робот, а DUID пуст, поля заполнятся сами.
4. IP облако обычно не отдаёт. **Найти в сети** слушает UDP 58866 около 8 секунд; если ничего не пришло, впишите IP из роутера. Если порт занят, его использует другое приложение на этой машине.
5. Нажмите Done, затем один раз Deploy. После этого ноды облако не используют.

IP, DUID, локальный ключ и модель хранятся в credentials устройства, а не в JSON потока. Перед переносом файла потоков на другую машину задайте постоянный `credentialSecret` в `settings.js`.

**Протокол.** Оставьте **Авто (рекомендуется)**: оно использует версию, которая сработала в прошлый раз, иначе ту, что сообщает облако, иначе 1.0, а затем пробует другую, и запоминает рабочую для устройства. Некоторые модели, например S8 Pro Ultra, в локальной сети отвечают только по L01, даже если облако сообщает 1.0. Явно выбранные 1.0 или L01 не перепроверяются.

**Ключ устарел.** Локальный ключ меняется, если робота удалили из приложения и добавили заново или сбросили Wi-Fi. Тогда команды висят по таймауту или появляется `decrypt failed`. Войдите в аккаунт, получите устройство заново и сделайте Deploy. IP тоже мог измениться.

### Комнаты и карты

**Назовите комнаты в приложении Roborock хотя бы раз.** Робот сообщает разметку комнат только для комнат, которым когда-либо дали имя. Пока этого нет, везде список комнат пуст: в **maps**, `map_rooms`, «Показать карты и комнаты» и в выборе комнат у **clean rooms**. Это не проблема соединения. Назовите комнаты в приложении и прочитайте снова.

- Робот описывает комнаты только **загруженного** этажа. **Обновить** перечитывает его, робота не меняя. **Загрузить эту карту** у другого этажа спрашивает подтверждение, загружает этаж, читает его комнаты и запоминает (пока робот убирает, отказ). Запомненные комнаты видны с пометкой «сохранено», даже когда загружен другой этаж. Если комнат нет и в сохранённой копии, один раз загрузите этаж.
- Имя комнаты показывается, только если разметка робота связывает её с комнатой в вашем аккаунте. Старые имена из облака не показываются.
- Id комнат повторяются на разных этажах, поэтому **clean rooms** хранит этаж вместе с комнатами и при необходимости сначала загружает его.

### Команды и события

- **command**: `start`, `pause`, `stop`, `dock`, `find`, `spot`. Если сразу после паузы `dock` отклонён как заблокированный (`-10003`), он повторяется один раз примерно через 12 секунд, `msg.retried` = `true`.
- **status**: выход 1 — статус, выход 2 — события `cleaning-started`, `cleaning-finished`, `paused`, `resumed`, `error`, `error-cleared`, `low-battery`. `cleaning-finished` приходит, когда флаг `in_cleaning` сбрасывается в 0, а робот делает это, как только его отправили домой, то есть в момент начала возврата, а не когда он встал на док. Для событий задайте интервал опроса.
- **clean rooms**: `msg.segments` (или `msg.rooms`), `msg.names`, `msg.mapFlag`, `msg.repeat`, `msg.fan`, `msg.mop` заменяют настройки ноды. `msg.payload` задаёт комнаты, только если это массив или объект с `segments`, `rooms`, `names`; число, строка и булево значение игнорируются.
- **settings**: мощность `silent`, `balanced`, `turbo`, `max`, `gentle`, `auto` (режимы 101–106 на большинстве современных моделей; для старых прошивок передайте число), мойка `off`, `low`, `medium`, `high`.
- **vacuum**: `start`, `pause`, `dock`, `status`, `{"command":"fan","speed":"turbo"}`, `{"command":"map_rooms"}`, `{"command":"map","mapFlag":1}`, `{"command":"rooms","segments":[16]}`, `{"command":"rooms","names":["Кухня"]}` (имя должно однозначно указывать на одну комнату загруженного этажа), `{"method":"get_consumable","params":[]}`.

### Если что-то не работает

- Таймаут рукопожатия: с машины Node-RED не открывается TCP 58867 (VLAN, гостевая сеть, файрвол). Проверьте `nc -vz <ip> 58867`.
- `No CONNACK`: робот не знает пробуемую версию протокола. Оставьте Авто.
- `decrypt failed` или таймаут RPC после подключения: устарел локальный ключ, получите его заново.
- «Найти в сети» ничего не слышит: повторите или впишите IP. `EADDRINUSE` на UDP 58866: порт занят другим приложением на этой машине (часто Home Assistant), впишите IP.
- Нет комнат: их ни разу не называли в приложении Roborock, либо этаж не загружен.

## License

MIT. Copyright (c) 2026 Oleg Chumakov.
