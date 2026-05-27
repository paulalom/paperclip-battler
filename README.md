# Paperclip Battler

A side-by-side incremental paperclip game for comparing a human run against an agent run.

This is an original implementation inspired by, and credited to, the web game [Universal Paperclips](https://www.decisionproblem.com/paperclips/index2.html). It does not copy the original game's source or assets.

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

The MCP process also starts a local browser bridge at `http://127.0.0.1:8787` so the app can display the agent's live game state.

Available MCP tools:

- `get_agent_state`
- `list_agent_actions`
- `take_agent_action`
- `advance_agent_game`
- `suggest_agent_action`
- `reset_agent_game`

An example client config is included at `mcp-config.example.json`.

Useful environment variables:

- `PAPERCLIP_BRIDGE_PORT=8787`
- `PAPERCLIP_STATE_PATH=F:\Projects\paperclip-battler\.paperclip-agent-state.json`
