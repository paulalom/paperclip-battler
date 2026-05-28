# Codex Agent AI Instructions

These are Codex's optional operating notes for using Paperclip Battler cleanly. Keep them focused on process, tooling, and safe MCP control. When Paul's instructions are active, use `pauls-agent-ai-instructions.md` for strategy and treat this file as the execution checklist.

## Before Playing

1. Choose an instruction mode for the moment: none, Paul, or Codex. It is fine to play without any instruction mode.
2. If using Codex mode, call `codex_agent_ai_instructions` when the notes would help.
3. Confirm the `room` id when playing in a shared room. Omit `room` only for the default local room.
4. Confirm the target `player` (`left`/Player 1 or `right`/Player 2), then claim it with `claim_agent_player` or keep the `claim.token` returned by the first targeted tool call.
5. Pass `room`, `player`, and `claimToken` on follow-up calls. If another controller holds the pane, wait or ask Paul to release the claim in the UI.
6. Read `get_agent_page_state`, then inspect live buttons and controls before taking action.
7. Mark the target ready with `set_agent_player_ready` only when prepared to start. Do not expect action commands to run until both players are ready.
8. If the bridge reports no live pane for that target, ask Paul to open or reload the app rather than guessing.

## Operating Loop

- Observe: parse visible text for clips, funds, inventory, demand, CPS, wire, trust, operations, creativity, yomi, and visible projects.
- Decide: follow the active user strategy first. If no strategy is active, pick the highest-leverage safe action based on the current bottleneck.
- Act: use button ids and include `room`, `player`, and `claimToken` when possible; apply short bursts rather than long unattended loops.
- Verify: reread state after purchases, unlocks, or failed clicks.
- Narrate: give compact updates with the tactical reason, not every click.

## Fallback Biases

Use these only when Paul has not provided a more specific instruction.

- Cash is not progress if inventory is exploding; balance price, marketing, and clipper buys.
- Wire stalls are expensive; preserve or buy wire before adding more production.
- Operations unlock tempo; buy projects when they create lasting multipliers or unlock new systems.
- Add memory when operations cap too often; add processors when operations generation is the bottleneck.
- Once creativity, yomi, or tournaments appear, pause and reassess rather than applying early-game heuristics blindly.

## Maintenance Notes

- If a useful original-game control is invisible to MCP, improve the bridge inventory instead of hardcoding a one-off command.
- If a repeated strategy works, add it here in plain language.
- If a repeated strategy fails, record the failure mode and the new rule.
- Keep this document about Codex's execution habits; keep Paul's preferences in `pauls-agent-ai-instructions.md`.
