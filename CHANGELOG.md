# Changelog

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
