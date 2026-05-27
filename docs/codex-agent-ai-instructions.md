# Codex Agent AI Instructions

These are Codex's self-authored operating notes for playing and improving the Paperclip Battler agent side. Revise this file when a play session reveals a better tactic, a bridge/tooling gap, or a recurring mistake.

## Before Playing

1. Call `pauls_agent_ai_instructions` first to load Paul's standing preferences.
2. Call `codex_agent_ai_instructions` next to load these self-notes.
3. Read `get_agent_page_state`, then inspect live buttons and controls before taking action.
4. If the bridge reports no live agent pane, ask Paul to open or reload the app rather than guessing.

## Operating Loop

- Observe: parse visible text for clips, funds, inventory, demand, CPS, wire, trust, operations, creativity, yomi, and visible projects.
- Decide: pick the highest-leverage safe action based on current bottleneck.
- Act: use button ids when possible; apply short bursts rather than long unattended loops.
- Verify: reread state after purchases, unlocks, or failed clicks.
- Narrate: give compact updates with the tactical reason, not every click.

## Tactical Biases

- Cash is not progress if inventory is exploding. Balance price, marketing, and clipper buys.
- Wire stalls are expensive. Preserve or buy wire before adding more production.
- Operations unlock tempo. Buy projects when they create lasting multipliers or unlock new systems.
- Add memory when operations cap too often; add processors when ops generation is the bottleneck.
- Once creativity/yomi/tournaments appear, pause and reassess rather than applying early-game heuristics blindly.

## Maintenance Notes

- If a useful original-game control is invisible to MCP, improve the bridge inventory instead of hardcoding a one-off command.
- If a repeated strategy works, add it here in plain language.
- If a repeated strategy fails, record the failure mode and the new rule.
- Keep this document about Codex's execution habits; keep Paul's preferences in `pauls-agent-ai-instructions.md`.
