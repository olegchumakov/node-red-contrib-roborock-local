# Changelog

## 0.1.0

- Local TCP control of Roborock vacuums on port 58867 (protocol 1.0, with an L01 handshake fallback).
- `roborock-account` and `roborock-device` config nodes that send a login code, accept a password, list devices, and store DUID, `local_key`, model, and IP in Node-RED credentials.
- Optional UDP discovery on port 58866 and a room-map join against `get_room_mapping`.
- `roborock-vacuum` node with shorthand commands, raw RPC, status polling, reconnects, and a keepalive.
- CLI helpers `roborock-local-test` and `roborock-cloud-login` for checking a real robot on the LAN.
