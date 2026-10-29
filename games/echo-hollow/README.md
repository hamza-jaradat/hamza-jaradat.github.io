# Echo Hollow

A stealth game in pitch-black caves. You can only see by sound: each ping sends out a
wave that lights up the walls it reaches. Gather every spore, then reach the gate. Blind
Listeners hear every ping and hunt toward where they heard it, so ping, then move.

## Run

From the repository root:

```bash
npm run dev -w games/echo-hollow
```

## Play

| Action | Input |
| --- | --- |
| Move | `W` `A` `S` `D` / arrow keys, hold the mouse button, drag on touch, or a gamepad stick |
| Ping | `Space`, right-click, the round button on touch screens, or gamepad `A` |
| Pause / mute | `Esc` / `M` |

Each cavern gets bigger, with more spores and more Listeners. Clearing one scores a
silence bonus (fewer pings), a speed bonus and an unharmed bonus, and gives back a
lost life.

## How it works

- `src/cave.js`: a cellular-automaton cave, smoothed into a signed distance field that
  drives collision, sonar rays, line of sight and spawn placement. Narrow passages fit
  the wisp but not the Listeners.
- `src/sonar.js`: each ping traces 640 rays once; the expanding wave reveals hit points
  as it passes them.
- `src/game.js`: rules, scoring and the Listeners' wander, hunt and search behaviour,
  using flow fields through the cave. Also an autopilot that plays the title-screen demo.
- `src/render.js`: light-on-darkness canvas drawing, with a faint memory of every wall
  revealed so far.
- `src/audio.js`: synthesized pings, chimes, growls and a heartbeat that quickens as a
  hunter closes in.
