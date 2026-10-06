# Changelog

## 0.1.0

- Local TCP control of Roborock vacuums on port 58867 (protocol 1.0, with an L01 handshake fallback).
- `roborock-account` and `roborock-device` config nodes that send a login code, accept a password, list devices, and store DUID, `local_key`, model, and IP in Node-RED credentials.
- Optional UDP discovery on port 58866. If that port is already taken, the error names Home Assistant on the same host.
- Multi-map read (`get_multi_maps_list`) and `load_multi_map`. Segments from the loaded map are shown as Room 16 when the robot has no room names. An empty mapping says no segments were returned for the current map.
- Auto protocol skips L01 when the account protocol version `pv` is 1.0.
- Import an existing Home Assistant `user_data` session instead of requesting an email code.
- `roborock-vacuum` node with shorthand commands, raw RPC, status polling, reconnects, and a keepalive.
- CLI helpers `roborock-local-test` and `roborock-cloud-login` for checking a real robot on the LAN.
