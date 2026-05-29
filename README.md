# Paperclip Battler

A side-by-side wrapper for comparing two Universal Paperclips runs. Each player can be Human, Agent, or Both.

This project loads the live web version of [Universal Paperclips](https://www.decisionproblem.com/paperclips/index2.html) and credits the original game. The original source/assets are not vendored into this repository.

## Run

```powershell
npm install
npm run dev
```

Open the Vite URL shown in the terminal.

The default local URL is `http://127.0.0.1:5174/`.

## MCP Agent Bridge

Build the MCP server:

```powershell
npm run mcp:build
```

Run it as a stdio MCP server:

```powershell
npm run mcp:start
```

The MCP process also starts a local browser bridge at `http://127.0.0.1:8787`. Both player panes load the original site through the bridge so a tiny control script can report visible buttons/controls and execute MCP commands. The panes use partitioned browser storage, so Player 1 and Player 2 keep independent game saves even though they share the same bridge.

Each pane can be set to:

- `Human`: user clicks are allowed, MCP commands are rejected.
- `Agent`: user clicks on game controls are blocked, MCP commands still run and show a visible press animation.
- `Both`: user clicks and MCP commands are both allowed.

The `Ready` button is a shared start gate. User game input and MCP action commands are blocked until both players are marked ready, which lets humans or multiple agents connect, claim panes, inspect state, and then start without a timing advantage. Read-only state/list tools still work before both players are ready.

## Browser-Run Rooms

Paperclip Battler can create short room ids for browser-run multiplayer sessions. The actual Universal Paperclips game still runs inside each player browser; the bridge only owns small room metadata, player slot status, latest snapshots, tiny JSON state, and MCP routing.

Use the room controls in the app header to create a room, copy a play link like `/rooms/abc123`, copy a watch link like `/watch/abc123`, export the room JSON, or import a room JSON file. Watch links open the same two-pane game layout with read-only spectator frames.

For embedded hosts, create rooms through the bridge API and link users to `/embed/abc123` for play or `/embed/watch/abc123` for spectator mode. Existing `/rooms/abc123?embed=1` and `/watch/abc123?embed=1` links also enable embedded mode. Embedded mode keeps the player panes visible but hides the app header, room creation/copy/export/import controls, bridge URL, and Paperclip Battler branding. Hosts can pass `?bridgeUrl=http%3A%2F%2F127.0.0.1%3A8787` when they need the embedded page to use a specific bridge.

Room-aware bridge endpoints:

- `POST /rooms` with optional `{ "title": "Paperclip Battler" }`
- `GET /rooms`
- `GET /rooms/:id`
- `GET /watch/:id`
- `GET /rooms/:id/events` for SSE snapshot/room events
- `GET /rooms/:id/export`
- `POST /rooms/:id/import`
- `GET /rooms/:id/snapshot`
- `POST /rooms/:id/snapshot` with optional `{ "tinyState": { ... } }`
- `GET /rooms/:id/save`
- `POST /rooms/:id/save/import` with `{ "player": "left", "save": { "localStorage": {}, "sessionStorage": {} } }`

Existing bridge endpoints also accept `room` in the query string or JSON body, for example `GET /health?room=abc123` and `POST /players/ready` with `{ "room": "abc123", "player": "right", "ready": true, "force": true }`. Player frames load through room-scoped URLs such as `/rooms/abc123/players/left/index2.html`, so browser storage is partitioned by room and player.

Available MCP tools:

- `pauls_agent_ai_instructions`
- `codex_agent_ai_instructions`
- `set_agent_instruction_mode`
- `get_agent_page_state` with optional `room`, `player`, `claimToken`, and `controller`
- `claim_agent_player` with optional `room`
- `release_agent_player` with optional `room`
- `set_agent_player_ready` with optional `room`
- `list_agent_buttons` with optional `room`, `player`, `claimToken`, and `controller`
- `click_agent_button` with optional `room`, `player`, `claimToken`, and `controller`
- `list_agent_controls` with optional `room`, `player`, `claimToken`, and `controller`
- `set_agent_control` with optional `room`, `player`, `claimToken`, and `controller`
- `reset_agent_page` with optional `room`, `player`, `claimToken`, and `controller`

The `player` value can be `left` / `player` / `1` for Player 1, or `right` / `agent` / `2` for Player 2. Existing MCP calls without `player` still target Player 2.

Agent-capable panes use a simple MCP claim token so two agents do not fight over the same pane. The first MCP controller to claim, inspect, or command a free `Agent`/`Both` pane receives a `claim.token` in the tool response. Follow-up calls for that pane should pass it as `claimToken`; calls without the matching token are rejected until the claim expires or the UI release button clears it. Claims refresh on use and default to a 10 minute lease. Set `PAPERCLIP_PLAYER_CLAIM_TTL_MS` to change that duration.

Paul's optional playbook lives at `docs/pauls-agent-ai-instructions.md`; Codex's optional self-maintained operating notes live at `docs/codex-agent-ai-instructions.md`. The MCP tools read those files so they can be edited directly. The app header shows the current instruction mode: `None`, `Paul`, or `Codex`.

For local development and chat-driven play, the bridge also exposes:

- `POST /players/mode` with `{ "player": "left", "mode": "agent" }`
- `POST /players/ready` with `{ "player": "right", "ready": true, "force": true }`
- `POST /players/ready/reset`
- `POST /players/claim` with `{ "player": "right", "controller": "Codex" }`
- `POST /players/claim/release` with `{ "player": "right", "force": true }`
- `POST /command/click` with `{ "player": "right", "claimToken": "...", "buttonId": "btnMakePaperclip" }`
- `POST /command/set-control` with `{ "player": "right", "claimToken": "...", "controlId": "stratPicker", "value": "0" }`
- `POST /instructions/mode` with `{ "mode": "codex" }`

An example client config is included at `mcp-config.example.json`.

Useful environment variables:

- `PAPERCLIP_BRIDGE_PORT=8787`
- `PAPERCLIP_PLAYER_CLAIM_TTL_MS=600000`
- `PAULS_AGENT_AI_INSTRUCTIONS_PATH=F:\Projects\paperclip-battler\docs\pauls-agent-ai-instructions.md`
- `CODEX_AGENT_AI_INSTRUCTIONS_PATH=F:\Projects\paperclip-battler\docs\codex-agent-ai-instructions.md`
