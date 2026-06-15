# Outline Newton

Control Outline Newton and Newton One DSP processors from Bitfocus Companion.

## Configuration

- **Device IP Address**: Newton IP address.
- **TCP Port**: command port, default `6668`.
- **Command Timeout**: per-command timeout for actions and polling.
- **Debug Logging**:
  - `Off`: quiet mode.
  - `Errors only`: command errors and rejected replies.
  - `Verbose hex`: raw TX/RX hex for protocol debugging.
- **Priority Patch Polling**: reads the `0x2B` signals blob and extracts bytes `666..689`.
- **Priority Monitor**: one selected priority patch exposed through compact variables and feedbacks.
- **VU Meter Listener**: experimental UDP listener on port `6667`. Keep disabled unless firmware sends VU packets.

## Core Actions

- **Set Gain**: sends command `0x01` with little-endian channel index and gain float.
- **Set Channel Mute**: sends command `0x01` with mute flag, preserving the configured gain value.
- **Set Delay**, **Set Polarity**, **Set Pan**, **Set Matrix Assignment**.
- **Change Preset** and **Store Preset**.

## Priority Patch Actions

- **Read Priority List**: sends `0x91` for one Input DSP or Aux Mixer patch. Some firmware versions reject this command; the module degrades cleanly and reports unsupported state.
- **Rearm Priority Patch**: sends `0x90` for one patch.
- **Rearm All Input DSP Priority Patches**: sends `0x90` to Input DSP patches `0..15`.
- **Rearm All Aux Mixer Priority Patches**: sends `0x90` to Aux Mixer patches `0..7`.

## Priority Patch Variables

- `$(outline-newton:priority_in_0)` to `priority_in_15`: active source for Input DSP priority patches.
- `$(outline-newton:priority_aux_0)` to `priority_aux_7`: active source for Aux Mixer priority patches.
- `$(outline-newton:priority_selected_active)`: active source for the configured monitored patch.
- `$(outline-newton:priority_selected_highest)`: highest source from `0x91` when supported, otherwise configured expected source.
- `$(outline-newton:priority_selected_forced)`: `yes`, `no`, `unsupported`, or `unknown`.
- `$(outline-newton:priority_selected_overridden)`: `yes` when active source differs from highest/expected source.

## VU Variables

- `$(outline-newton:vu_selected)`: monitored VU channel value, or a clear status string.
- `$(outline-newton:vu_selected_peak)`: monitored peak value.
- `$(outline-newton:vu_selected_clip)`: `yes`, `no`, or status string.
- `$(outline-newton:vu_raw_length)`: last UDP packet length.
- `$(outline-newton:vu_raw_first_hex)`: first bytes of the last UDP packet.
- `$(outline-newton:vu_format)`: decoded format or `Unknown VU format`.

## Debug Variables

- `$(outline-newton:last_command)`
- `$(outline-newton:last_response_hex)`
- `$(outline-newton:last_error)`
- `$(outline-newton:last_priority_update)`
- `$(outline-newton:last_vu_update)`

## Operator Examples

- Put a **Priority Patch Status** preset on a button to show the active source.
- Put a **Rearm Priority Patch** preset beside it. If the status button turns orange, press rearm.
- Enable verbose logging only during protocol debugging; it can produce a lot of hex traffic.

## Protocol Notes

- Legacy commands use the first byte as command ID.
- Legacy success is usually `0x33 0x00`; error is `0x66 0x00`.
- Newton 3 firmware `0.98` returns a raw 1024-byte blob for `0x2B`, not a standard OK header.
- All 4-byte integer and float fields in legacy commands are little-endian.
- Snapshot commands use SPC/SPR with CRC16 (`0xA001`, initial `0x0000`, CRC stored little-endian).
