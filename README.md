# companion-module-outline-newton

[Bitfocus Companion](https://bitfocus.io/companion) module to control [Outline Newton](https://outline.it) DSP processors. Commands, configuration reads and snapshot traffic use TCP port 6668; real-time meter/status samples use UDP port 6667.

## Features

- **Input patch**: monitor the active priority source of inputs 1–16, rearm a single input or all inputs to their top-priority source
- **Clock**: monitor and rearm Master Clock and Word Clock Out 1/2
- **Levels & mute**: live gain display, mute toggle, relative level up/down for Input/Output DSP channels 1–16
- **Snapshots**: apply device snapshots by name, with fading time and transition mode
- **Metering**: full-height LED-style VU meter buttons (Peak/RMS, per channel), queried over UDP and also exposed as variables
- **Status**: connection state, action-result feedbacks and diagnostics variables for triggers

See [companion/HELP.md](companion/HELP.md) (shown as the connection help inside Companion) for the full list of actions, feedbacks, presets and variables.

## Configuration

Set the Newton's **IP address**, then choose the Low, Medium or High interactivity profile. Changing the profile immediately recreates the UDP meter socket with the selected cadence. Companion opens TCP control traffic to Newton on port 6668. Meter/status queries go to Newton over UDP port 6667, and the operating system chooses Companion's local UDP reply port. TCP is never used for meter data.

## Requirements

- Bitfocus Companion 4.0 or later
- An Outline Newton reachable from the Companion host over TCP port 6668 and UDP port 6667
- Snapshots require Newton firmware 0.98 or later (auto-detected; every other feature works on older firmware)

## Development

Requires Node.js 22 and Yarn.

```bash
yarn install
yarn dev        # watch build
yarn build      # compile and package the module (.tgz)
yarn test       # build + protocol tests
yarn lint:raw   # eslint
yarn typecheck
```

The packaged `.tgz` produced by `yarn build` can be installed in Companion via *Modules → Import module package*.

## License

[MIT](LICENSE)
