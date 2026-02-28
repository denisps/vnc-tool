# Command Reference

## Global options

| Option | Short | Default | Description |
|--------|-------|---------|-------------|
| `--host HOST` | `-H` | `localhost` | VNC server hostname or IP |
| `--port PORT` | `-p` | `5900` | VNC server port |
| `--password PASS` | `-P` | — | VNC password |
| `--session ID` | `-s` | — | Use named persistent session |
| `--timeout MS` | | `10000` | Connection / operation timeout (ms) |
| `--json` | | false | Output JSON for machine consumption |
| `--help` | `-h` | | Print help |
| `--version` | `-v` | | Print version |

---

## Commands

### `screenshot [file]`

Capture the screen and write to `file`. If `file` is omitted, writes raw PNG to stdout.

```
vnc --host 10.0.0.5 screenshot /tmp/screen.png
vnc --host 10.0.0.5 screenshot > /tmp/screen.png
```

---

### `click <x> <y> [button]`

Click at `(x, y)`. `button` is `left` (default), `right`, or `middle`.

```
vnc --host 10.0.0.5 click 640 400
vnc --host 10.0.0.5 click 640 400 right
```

---

### `move <x> <y>`

Move the mouse cursor without clicking.

```
vnc --host 10.0.0.5 move 320 240
```

---

### `mousedown <x> <y> [button]`

Press and hold a mouse button at `(x, y)`.

---

### `mouseup <x> <y> [button]`

Release a mouse button at `(x, y)`.

---

### `scroll <x> <y> [amount]`

Scroll at position `(x, y)`. Positive `amount` scrolls down, negative scrolls up. Default amount is `3`.

```
vnc --host 10.0.0.5 scroll 640 400 5    # scroll down 5 steps
vnc --host 10.0.0.5 scroll 640 400 -3   # scroll up 3 steps
```

---

### `type <text>`

Type a text string by sending individual key events.

```
vnc --host 10.0.0.5 type "Hello, World!"
```

---

### `key <combo>`

Press and release a key combination. Modifiers are joined with `+`.

```
vnc --host 10.0.0.5 key ctrl+c
vnc --host 10.0.0.5 key ctrl+alt+del
vnc --host 10.0.0.5 key alt+F4
vnc --host 10.0.0.5 key Return
vnc --host 10.0.0.5 key super+l
```

Supported modifiers: `ctrl`, `shift`, `alt`, `meta`/`super`/`win`.

Supported special keys: `Return`/`Enter`, `Escape`/`Esc`, `Tab`, `BackSpace`, `Delete`, `Insert`,
`Home`, `End`, `PageUp`, `PageDown`, `Left`, `Right`, `Up`, `Down`,
`F1`–`F12`, `Print`, `CapsLock`, `NumLock`, `ScrollLock`.

---

### `keydown <key>`

Press and hold a key (does not release).

---

### `keyup <key>`

Release a held key.

---

### `delay <ms>`

Wait for `ms` milliseconds before continuing.

---

### `run <json | ->`

Execute a batch of commands from a JSON array. Pass `-` to read from stdin.

```bash
vnc --host 10.0.0.5 run '[
  {"cmd":"screenshot","file":"/tmp/before.png"},
  {"cmd":"click","x":640,"y":400},
  {"cmd":"type","text":"query"},
  {"cmd":"key","combo":"Return"},
  {"cmd":"delay","ms":1000},
  {"cmd":"screenshot","file":"/tmp/after.png"}
]'
```

**Batch command objects:**

| Field | Type | Description |
|-------|------|-------------|
| `cmd` | string | Command name (any of the commands above) |
| `x`, `y` | number | Coordinates (click, move, scroll, mousedown, mouseup) |
| `button` | string | `left`\|`right`\|`middle` (click, mousedown, mouseup) |
| `amount` | number | Scroll amount (scroll) |
| `text` | string | Text to type (type) |
| `combo` | string | Key combination (key) |
| `key` | string | Key name (keydown, keyup) |
| `ms` | number | Milliseconds (delay) |
| `file` | string | Output path (screenshot) |

---

### `start`

Start a persistent background session. Requires `--session` and `--host`.

```
vnc --host 10.0.0.5 --session work start
```

---

### `stop`

Stop a persistent session and clean up. Requires `--session`.

```
vnc --session work stop
```

---

### `list`

List all currently active sessions.

```
vnc list
```

---

## JSON output mode

With `--json`, every command outputs a JSON object:

```json
{"ok": true, "message": "Clicked (100, 200) with left"}
{"ok": false, "error": "Connection refused"}
```

Exit code is `0` on success and `1` on error, regardless of `--json`.

---

## Environment

Session socket and PID files are stored under `~/.vnc-tool/sessions/`.
