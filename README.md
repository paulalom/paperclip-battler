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

- `pauls_agent_ai_instructions`
- `get_agent_page_state`
- `list_agent_buttons`
- `click_agent_button`
- `list_agent_controls`
- `set_agent_control`
- `reset_agent_page`

Paul's standing playbook lives at `docs/pauls-agent-ai-instructions.md`; the MCP tool reads that file so it can be edited directly.

For local development and chat-driven play, the bridge also exposes:

- `POST /command/click` with `{ "buttonId": "btnMakePaperclip" }`
- `POST /command/set-control` with `{ "controlId": "stratPicker", "value": "0" }`

An example client config is included at `mcp-config.example.json`.

Useful environment variables:

- `PAPERCLIP_BRIDGE_PORT=8787`
- `PAULS_AGENT_AI_INSTRUCTIONS_PATH=F:\Projects\paperclip-battler\docs\pauls-agent-ai-instructions.md`
