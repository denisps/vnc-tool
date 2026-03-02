# vnc-tool

CLI tool for controlling a VNC server — designed for AI agents, CI pipelines, and workstation auditing.

## Install

```bash
git clone https://github.com/your-org/vnc-tool
cd vnc-tool
npm install   # no production dependencies
chmod 755 bin/vnc
```

Add to your `PATH` or use `node bin/vnc` directly.

## Quick start

```bash
# Take a screenshot
vnc --host 192.168.1.10 screenshot screen.png

# Click at coordinates
vnc --host 192.168.1.10 -P mypassword click 640 400

# Type text
vnc --host 192.168.1.10 type "hello world"

# Press key combo
vnc --host 192.168.1.10 key ctrl+c

# Scroll down 5 steps
vnc --host 192.168.1.10 scroll 640 400 5
```

## Persistent sessions

A session keeps a VNC connection open in a background daemon, avoiding reconnect overhead.

```bash
# Start a session
vnc --host 192.168.1.10 -P secret --session mybox start

# Use the session for subsequent commands
vnc --session mybox screenshot latest.png
vnc --session mybox click 100 200
vnc --session mybox type "automation text"

# List running sessions
vnc list

# Stop a session
vnc --session mybox stop
```

## Batch / JSON mode

Run multiple commands in one connection. Pass a JSON array or `-` to read from stdin.

```bash
vnc --host 192.168.1.10 run '[
  {"cmd":"move","x":640,"y":400},
  {"cmd":"click","x":640,"y":400,"button":"left"},
  {"cmd":"type","text":"hello"},
  {"cmd":"key","combo":"Return"},
  {"cmd":"delay","ms":500},
  {"cmd":"screenshot","file":"/tmp/result.png"}
]'
```

Machine-readable JSON output (for AI agents):

```bash
vnc --host 192.168.1.10 --json click 100 200
# → {"ok":true,"message":"Clicked (100, 200) with left"}
```

## Command reference

See [docs/commands.md](docs/commands.md) for the full command reference and all options.

## Testing

```bash
npm test           # run all tests (requires no real VNC server)
npm run test:verbose   # verbose output
```

Tests use Node.js built-in `node:test` and an in-process mock VNC server.

An additional optional integration test (`test/qemu.test.js`) exercises a real
`qemu-system-x86_64` instance started with `-vnc`. It will capture PNG
screenshots after every major update and attempt to enter the firmware BIOS. The
test is skipped automatically if QEMU is not present, so the normal test suite
remains lightweight.
