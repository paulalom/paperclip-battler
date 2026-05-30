# Heuristic AI Decisions

The heuristic AI is a deterministic browser controller for Universal Paperclips. It is intentionally simple: make safe obvious clicks, avoid destructive actions, and keep running in background tabs by accepting bridge-driven tick events when available.

## Preconditions

- The player must be in `Heuristic` mode.
- Both players must be ready.
- A target button must be visible, enabled, and reported as allowed by the same availability checks used by MCP commands.
- Manual user game input stays locked while heuristic mode is active.
- The heuristic only acts by clicking allowed buttons. It does not directly edit game globals, rewrite visible stat text, or set form control values.

## Timing

- Manual paperclip clicks run at no more than 8 clicks per second, one `Make Paperclip` click every 125 ms.
- A page-local timestamp guard enforces the 125 ms minimum between manual clicks even if bridge ticks and browser fallback ticks arrive close together.
- Broader AI decisions run every 750 ms.
- If bridge-driven heuristic tick events are fresh, browser fallback timers stand down.
- Status reports are coalesced so fast paperclip clicks do not create fast storage snapshots.

## Decision Order

Each broad decision tick tries these rules in order and stops after the first successful click.

1. Wire management
   - If wire is below `1` and the current wire spool is affordable, click `Wire` at any price.
   - If wire is below `1` and the current wire spool is not affordable, click `Beg for More Wire` when that recovery project is available.
   - Treat any fractional wire below `1` as a production stall; the game can leave partial wire after fractional-rate manufacturing.
   - If wire is below `500`, reserve `$20.00` as the average wire-spool price and skip cash purchases that would spend below that floor.
   - If wire cost is `14` or lower, buy early until wire reaches `2,000`.
   - If wire cost is `12` or lower, buy early until wire reaches `5,000`.
   - If wire cost is `10` or lower, buy early until wire reaches `10,000`.

2. Paperclip price management
   - Price rules read visible/global `unsoldClips`, `demand`, and `margin`. If inventory cannot be read, skip price management for that tick.
   - Price adjustments share a 3 second cooldown on `price:adjust`, so they cannot monopolize broad decision ticks.
   - Rules are evaluated in this order and stop after the first successful allowed button click.
   - If public demand is `5%` or lower, click `lower` when the price is unknown or above `$0.01`.
   - If unsold inventory is above `150`, click `lower`.
   - If unsold inventory is above `75` while demand is below `20%`, click `lower` when the price is unknown or above `$0.01`.
   - If unsold inventory is below `50` and demand is unknown or at least `20%`, click `raise`.
   - Otherwise, including inventory from `50` through `150`, leave price alone.

3. Tournament, probe, and trust management
   - Run enabled tournaments to produce yomi.
   - In space, increase probe trust when possible, allocate probe trust toward replication, hazard resistance, exploration, speed, factories, harvesters, wire, and combat, then launch probes.
   - For computational trust, add memory when visible projects need a larger operations cap, add memory when the cap is full, otherwise keep processors and memory roughly balanced.

4. Button-priority fallback
   - Prefer projects, probes, drones, factories, harvesters, tournaments, and strategy buttons.
   - Then prefer processors, memory, operations, compute, and quantum buttons.
   - Then prefer auto clipper and mega clipper buttons.
   - Then prefer marketing and demand buttons.
   - Then allow other visible non-destructive buttons.

## Exclusions

- Never click reset, restart, import, export, load, save, investment, deposit, or withdraw controls.
- Do not let the generic button-priority fallback buy wire; wire buying is controlled only by the wire management rule.
- Do not let the generic button-priority fallback click `Make Paperclip`; manual paperclip production has its own fast tick.
