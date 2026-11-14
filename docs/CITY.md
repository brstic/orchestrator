# Out in the city

_Built on 2026-11-14 on the owner's request: "make the city really huge (only the part we see is drawn), let me jump off this building, a parachute opens and I drift slowly down to the street; down there I can take a car and drive… as soon as I jump I get a Back to Office button somewhere. The city should be procedurally generated, with traffic, people walking the streets and so on."_

Where the office stands over the city (*Settings → The office → Surroundings → Skyline*, `SURROUNDINGS.md`), the owner's character can leave it through a window and go down into the city: falling, under a parachute, on foot, at the wheel of a car taken out of the traffic. This page says what one can do there, how it is built, and its limits. Read it before touching `packages/office-3d/src/city/`, `surroundings/skyline.ts` or `surroundings/traffic.ts`, or the outside part of `Rig.tsx`.

## What one can do

| Where | Keys | What happens |
| --- | --- | --- |
| At an outer window (Skyline only) | **Space** (the interact key) — "JUMP OUT OF THE WINDOW" | Over the balustrade at the terrace's edge, out into the air. The camera follows from behind; **Back to Office** appears at the bottom at once |
| Falling | A / D, W | A little steering; **Space** opens the parachute at once |
| Falling, after 1.2 s | — | The **parachute opens by itself** (only with more than 12 m to spare; a shorter drop is a fall onto one's feet) |
| Under the parachute | W / S faster or slower, A / D steer | Sinking about 5 m a second, gliding 4–10 m a second. One lands on whatever is below: the street, or a roof |
| On foot | W A S D, Q / E sideways, Shift to run, Space to jump | Walking among the very buildings that are drawn (they are solid). Off a roof's edge one falls — and the parachute opens again if it is high |
| Next to a car of the traffic (within 4.5 m; not a bus) | **F** — "DRIVE THIS CAR" | That car leaves the traffic and is yours: its paint, its place |
| At the wheel | W accelerate, S brake and reverse, A / D steer, **Shift** faster (40 m/s instead of 24) | Buildings stop it (it bounces back a little). **F** gets out on the driver's side; the car stays where it was left, and F next to it takes it again |
| Anywhere outside | **Back to Office** (the button) | Back where one stood in the office, turned to face into it |
| Landing on the office's own terrace | — | Back in the office, as with the button |

While outside, the office's own meanings of Space, F, R and C wait (no jump-in-place, talk, whip or camera change); windows (M, T, …) still open. The mouse turns the camera; the wheel brings it nearer or further.

## The city

- **Without end, drawn only round the camera.** Blocks are made from their own two numbers (`blockAt(i, j)` in `city/blocks.ts`, its own random numbers seeded by `i` and `j`): the same block is the same on every computer and every time. `skyline.ts` lays out the 13 × 13 blocks round the block the camera is over, and lays them out again when the camera reaches another block (the made blocks are kept, up to 900); the street picture under them moves with it. The fog hides where the drawn city ends.
- **Districts.** How tall a block is follows a noise field over many blocks (`districtOf`): the cluster of towers the office always looked at to the north-west, and other downtowns far away. Now and then a block is a **park** (a lawn and trees). Near the office the view is kept open, as before.
- **What a building is** — fronts, podiums, setbacks, round towers, roofs with machine rooms and water tanks — is as described in `SURROUNDINGS.md`, "The Skyline's city"; the same `Part`s are drawn and the same `Solid`s are walked into. Street trees have trunks, and crowns high enough to walk under.
- **Traffic without end.** The traffic (`traffic.ts`) is a pattern that repeats every 13 blocks along a street and every 14 streets across them, laid round wherever one looks from (`near`, `vehicleAt`; the shader's `nearTo`). Every street near by has its traffic; a lane comes round again far away, in the fog. The lights, the queues and nobody driving into anybody are as before (`traffic.test.ts`).
- **People on the pavements.** Some 1,300 walkers (600 on *Low*), two rings round each block — one each way — in a pattern of 9 × 9 blocks laid round the camera like the traffic. Each is one shape moved by the graphics card from the time alone: round the block, turning at the corners, legs and arms swinging with the stride.

## How it is put together

```
OfficeScene ── Surroundings ── buildSkyline (skyline.ts)     the blocks round the camera, ground, traffic, walkers, lights
           └── Rig ─────────── outside? → cityFrame            step (explorer.ts), car in/out, camera, body
                    └────────── CityGear (city/gear.tsx)      the parachute, the car one drives, the car one left
```

- **`city/blocks.ts`** (pure): the grid (`PITCH` 116 m, streets 20 m wide, the street 150 m under the office floor), `blockAt`, `streetTrees`, `solidsNear`, `groundAt`, `blocked`.
- **`city/explorer.ts`** (pure): one state (`Explorer`: phase `fall | chute | foot | car`, position, speeds, the parachute's opening) and one step (`step`) from the keys; `leap` (out of the window), `board` and `alight` (the car).
- **`Rig.tsx`**: the outer windows (`glazed(world)`, glass in outer walls) give the "jump out" prompt within 1.15 m; on going out it remembers where the owner stood (`home`) and starts a `leap` from the terrace's edge outside the nearest window. Each frame outside it runs `cityFrame` instead of the office's movement: the step, getting in and out of a car (the nearest vehicle of `cityTraffic`, found with `vehicleAt` from the same clock and the same origin the picture uses), the camera behind (pulled in front of any building between it and the body, kept under the trees on the street), the body's gait, and the gear. The office's own tower is one more solid with its top at 0: landing there is coming home.
- **Taking a car out of the traffic**: `cityLive.taken` (in `skyline.ts`) is the vehicle's index; the picture hides that instance (`aCar.w = -1`, and its lights) until another is taken or the owner is back.
- **The HUD** (`apps/desktop`): `outside`, `goOutside`, `backToOffice`, `outsideHint` in the store; the prompt at the bottom shows what the keys do just now and **Back to Office** (`[data-outside]`); `interact()` turns the window prompt into `goOutside`.

## Others, and the server

**Nothing of this reaches the server or the others.** While outside, the position the office reports for the owner (`ownerPosition`, the presence) stays where they jumped from: the others see them standing at the window. The city is the same for everybody (it is made from numbers), but nobody else sees anybody in it. A colleague and a visitor can go out too wherever they can walk the office (the window prompt is a thing of the scene, like a seat).

## Testing it

| Test | What it covers |
| --- | --- |
| `packages/office-3d/test/explorer.test.ts` | a block the same every time and nothing on the office's; buildings kept off the streets far away; out of the window: the parachute after 1.2 s, sinking slowly, landing on the street; a short drop without a parachute; not walking into a building; landing on a roof and falling off its edge (the parachute again); driving, turning, stopping at a building, getting out beside the car |
| `packages/office-3d/test/traffic.test.ts` | the traffic (see `SURROUNDINGS.md`) |
| `tests/ui/surroundings.mjs` (the Skyline step) | with real keys in the app: the window prompt, Space out, **Back to Office** at once, the parachute by itself and its sink rate, the landing, "F — drive this car" beside a queue, F takes that car out of the traffic, it drives, F gets out and the car stays, kilometres away the city is built up all round, the other window still sees the owner where they jumped from, the button brings them back where they stood |

## Limits, plainly

- **Alone out there.** Nobody else sees you in the city, and you see nobody of the office.
- **Cars are not run into.** Your car drives through the traffic and through walkers; walkers walk through you. Only buildings stop anything.
- **The traffic goes straight on** and all the lights change together (as before); vehicles of the pattern come round again far off.
- **No damage, no falls that hurt.** A fall without a parachute lands on its feet.
- **Round towers are stood against as a square a little inside them**: near enough at a walk, a car can touch the curve.
- **Inside a narrow gap between two buildings** (they are built up to each other, 1.5–4 m apart) the camera has little room.
- **The keys are fixed** out there (F for the car, Space to jump or open the parachute), whatever the office's key settings say for F.
- **Only the Skyline** has a city to go down into.
