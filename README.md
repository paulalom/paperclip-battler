# Paperclip Battler

A side-by-side wrapper for comparing a human Universal Paperclips run against an agent-controlled run.

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

The MCP process also starts a local browser bridge at `http://127.0.0.1:8787`. The Player pane loads the original site directly. The Agent pane loads the original site through the bridge so a tiny control script can report visible buttons/controls and execute MCP commands.

Available MCP tools:

- `get_agent_page_state`
- `list_agent_buttons`
- `click_agent_button`
- `list_agent_controls`
- `set_agent_control`
- `reset_agent_page`

An example client config is included at `mcp-config.example.json`.

Useful environment variables:

- `PAPERCLIP_BRIDGE_PORT=8787`
