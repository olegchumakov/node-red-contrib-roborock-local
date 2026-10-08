# Changelog

## Unreleased

- New dedicated nodes: **command**, **status**, **clean rooms**, **settings**, **maps**, and **consumables**. They share the existing **roborock device** and its one TCP connection. **vacuum** stays as the universal node for any shorthand or raw `{"method","params"}`, including new or undocumented commands.
- **status** sends events on a second output: `cleaning-started`, `cleaning-finished`, `error`, `error-cleared`, and a one-shot `low-battery`. Any input message reads the status on demand.
- **clean rooms** picks rooms and the floor from the robot in the editor, switches floors first when needed (refused while the robot is cleaning), and can set repeats, fan, and mop.
- **command** only accepts plain actions, so a typo is rejected instead of being sent to the robot as an RPC method.
- **consumables** reports percent left per wear part and has a separate output for worn parts.
- Every node keeps the incoming message on its output (`msg.topic` and your own properties pass through). This includes **vacuum**, which used to start a new message.
- After a failed command the node status line returns to the robot's last known state after a few seconds instead of staying red.
- The new nodes have English and Russian editor text and help.
- Loading a floor moved into `lib/floor.js`; the device editor behaves as before. A floor that is already loaded is only re-read: `load_multi_map` is not sent.
- Auto protocol no longer trusts the account's `pv`. It tries the version that worked last time, else the account `pv`, else 1.0, and then the other one, and remembers the working version per device in `roborock-local-protocol-cache.json` in the Node-RED user directory. Some firmware (an S8 Pro Ultra, `roborock.vacuum.a51`) reports 1.0 in the cloud but answers only L01 on the LAN. A forced protocol is not second-guessed.
- The `fan` and `mop` shorthand on **vacuum** now send one-element lists (`[103]`, `[202]`), as the settings and clean rooms nodes do. A bare number was ignored for fan and refused for mop (`Params is not an Array (-10007)`).
- **clean rooms**: `msg.payload` names rooms only when it is an array or an object with `segments`, `rooms`, or `names`. A number, string, or boolean (such as the default inject timestamp) can no longer replace the rooms set on the node. `msg.rooms` is accepted as another name for `msg.segments`.
- **status** and **consumables** keep the incoming `msg.topic`. What the message is goes in `msg.kind` (`status`, `event`, `consumables`, `consumables-low`); events also have `msg.event`. Events never carry an incoming message, and overlapping on-demand reads each answer their own message.
- **status** events follow the robot's `in_cleaning` flag. A pause is `paused`, a resume is `resumed` (not a new `cleaning-started`), and `cleaning-finished` is sent only when the clean really ends, not on a pause or while returning with `in_cleaning` still set.
- **command**: a `dock` refused as `action locked (-10003)` (right after a pause) is retried once after about 12 seconds; `msg.retried` is `true`.
- Errors say what is missing on the device (IP, local key, both, or no device selected), and so does the node status line.
- Documented: rooms must be named in the Roborock app at least once, otherwise `get_room_mapping` is `[]` and no rooms are listed. The room picker's no-rooms note says so too.

## 0.2.2

- **Show maps & rooms** has **Reload** on the loaded floor. It re-reads `get_room_mapping` and cloud room names and refreshes the saved copy. It does not change the robot and does not ask for confirmation.
- Other floors have **Load this map**. The editor asks first, then sends `load_multi_map` with `[mapFlag]` (a number), reads that floor's rooms, and can switch back to the previous floor. The load is refused while the robot is cleaning.
- Rooms read for the loaded map (from the editor or `{"command":"map_rooms"}`) are saved per device, keyed by DUID and map id, in `roborock-local-map-cache.json` under the Node-RED user directory. No deploy is required. Later lists and `map_rooms` show those rooms for floors that are not loaded, with `cached: true` and `cachedAt`. A room name used in `{"command":"rooms","names":[...]}` resolves only against the loaded map, including that map's cache.

## 0.2.1

- The device editor no longer stores a map or switches floors. **Show maps & rooms** is a read-only list (map name, `mapFlag`, room ids). Saved `rooms` and other map fields from 0.1.x / 0.2.0 are ignored and do not have to be removed.
- `get_room_mapping` is only the loaded map (`[segmentId, cloudRoomId, tag]`; the third value is a room tag, not a map id). Other floors show room ids when `get_multi_maps_list` includes a `rooms` array. Otherwise the list says `rooms visible when this map is loaded`. The editor does not call `load_multi_map`.
- Room names are shown only when `get_room_mapping` links a segment to a cloud home room id (account session cache or saved account credentials), or when that map entry included `iot_name`. Unlinked home-room names are not shown.
- Vacuum commands, unchanged where they already existed: `{"command":"map","mapFlag":1}` loads a floor (`[mapFlag]`, number). `{"command":"rooms","segments":[16]}` cleans those ids on the loaded map. `{"command":"rooms","names":["Kitchen"]}` works when the name matches one segment. New read command `{"command":"map_rooms"}` (alias `maps_rooms`) puts the maps-and-rooms list on `msg.payload`. `{"command":"maps"}` is still the raw `get_multi_maps_list` result.

## 0.2.0

- Cloud login (email code, password, and Home Assistant session import) is only on `roborock-account`. The device node no longer has those fields. One account can supply several vacuums.
- Fetch devices works before deploy. Signing in stores the session in the account credentials on Done and in a 15-minute editor cache that is cleared on deploy. Setup is one Deploy: add the vacuum, sign in on the account, Done, pick the vacuum, Done, Deploy.
- Selecting an account on a device that has no DUID yet fills the vacuum in when the account has one robot.
- A cloud session left on a device node from 0.1.0 is ignored. Local control still uses the saved IP, DUID, local key, and `pv`, and logs a one-time hint.
- `load_multi_map` is sent as `[mapFlag]` with a number. A nested array was rejected by the S7 (`First element in array is not an Number`).
- Maps and rooms are an optional collapsed section. An empty `get_room_mapping` (`[]`) is treated as normal when the floor has no room split. The device config no longer asks for segment ids; pass them in `msg.payload` when you want room cleaning.

## 0.1.0

- Local TCP control of Roborock vacuums on port 58867 (protocol 1.0, with an L01 handshake fallback).
- `roborock-account` and `roborock-device` config nodes that send a login code, accept a password, list devices, and store DUID, `local_key`, model, and IP in Node-RED credentials.
- Optional UDP discovery on port 58866. If that port is already taken, the error names Home Assistant on the same host.
- Multi-map read (`get_multi_maps_list`) and `load_multi_map`. Map names are kept as the robot sent them (plain UTF-8, not percent-decoded). Segments from the loaded map are shown as Room 16 when the robot has no room names. An empty mapping says no segments were returned for this map and does not infer room splits from `lab_status` or `unsave_map_flag`. If `get_room_mapping` fails, the map list is still returned with `mappingError`.
- A current map flag is derived from `map_status` only for the 3, 7, 11, 15, … pattern. Any other value stays unknown.
- Auto protocol skips L01 when the account protocol version `pv` is 1.0.
- Import an existing Home Assistant `user_data` session instead of requesting an email code.
- `roborock-vacuum` node with shorthand commands, raw RPC, status polling, reconnects, and a keepalive.
- CLI helpers `roborock-local-test` and `roborock-cloud-login` for checking a real robot on the LAN. The local test reads the key from `ROBOROCK_LOCAL_KEY`, stdin, or a prompt. `--key` warns that the key lands in shell history. Commands are limited to `get_*` unless `--allow-write` is set.
