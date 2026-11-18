# Out in the city

_Built on 2026-11-14 on the owner's request: "make the city really huge (only the part we see is drawn), let me jump off this building, a parachute opens and I drift slowly down to the street; down there I can take a car and drive… as soon as I jump I get a Back to Office button somewhere. The city should be procedurally generated, with traffic, people walking the streets and so on."_

Where the office stands over the city (*Settings → The office → Surroundings → Skyline*, `SURROUNDINGS.md`), the owner's character can leave it through a window and go down into the city: falling, under a parachute, on foot, at the wheel of a car taken out of the traffic. This page says what one can do there, how it is built, and its limits. Read it before touching `packages/office-3d/src/city/`, `surroundings/skyline.ts` or `surroundings/traffic.ts`, or the outside part of `Rig.tsx`.

## What one can do

| Where | Keys | What happens |
| --- | --- | --- |
| On the terrace (Skyline only) | walk out of the door | The terrace round the office is floor: one walks all the way round, up to its glass balustrade |
| At the balustrade (within 1.1 m of the terrace's edge) | **Space** (the interact key) — "JUMP OFF THE EDGE" | Over the balustrade, out into the air, facing away from the building. The camera follows from behind; **Back to Office** appears at the bottom at once |
| Falling | A / D, W | A little steering; **Space** opens the parachute at once |
| Falling, after 1.2 s | — | The **parachute opens by itself** (only with more than 12 m to spare; a shorter drop is a fall onto one's feet) |
| Under the parachute | W / S faster or slower, A / D steer | A ram-air wing of nine cells opens over the shoulders (`gear.tsx`), leaning into the turns. Sinking about 5 m a second, gliding 4–10 m a second. One lands on whatever is below: the street, or a roof |
| On foot | W A S D, Q / E sideways, Shift to run, Space to jump | Walking among the very buildings that are drawn (they are solid). Off a roof's edge one falls — and the parachute opens again if it is high |
| Next to a car of the traffic (within 4.5 m; not a bus) | **F** — "DRIVE THIS CAR" | That car leaves the traffic and is yours: its paint, its place |
| At the wheel | W accelerate, S brake and reverse, A / D steer, **Shift** faster (40 m/s instead of 24) | Buildings stop it (it bounces back a little). **F** gets out on the driver's side; the car stays where it was left, and F next to it takes it again |
| Anywhere outside | **Back to Office** (the button) | Back where one stood in the office, turned to face into it |
| Landing on the office's own terrace | — | Back in the office, as with the button |
| Next to somebody else's car while they drive (within 4.5 m) | **F** — "RIDE WITH …" | In the seat beside them: wherever they drive, you go. **F** gets out; when they get out (or go back in), so do you |
| Anywhere outside, with others out there too | **Go to …** (a button for each, up to four) | Beside them: on foot next to them, next to their car, or — when they are in the air — under your own parachute nine metres to their side |

While outside, the office's own meanings of Space, F, R and C wait (no jump-in-place, talk, whip or camera change); windows (M, T, …) still open. The mouse turns the camera; the wheel brings it nearer or further.

## The city

- **Without end, drawn only round the camera.** Blocks are made from their own two numbers (`blockAt(i, j)` in `city/blocks.ts`, its own random numbers seeded by `i` and `j`): the same block is the same on every computer and every time. `skyline.ts` lays out the 13 × 13 blocks round the block the camera is over, and lays them out again when the camera reaches another block (the made blocks are kept, up to 900); the street picture under them moves with it. The fog hides where the drawn city ends.
- **Districts.** How tall a block is follows a noise field over many blocks (`districtOf`): the cluster of towers the office always looked at to the north-west, and other downtowns far away. Now and then a block is a **park** (a lawn and trees). Near the office the view is kept open, as before.
- **What a building is** — fronts, podiums, setbacks, round towers, roofs with machine rooms and water tanks — is as described in `SURROUNDINGS.md`, "The Skyline's city"; the same `Part`s are drawn and the same `Solid`s are walked into. Street trees have trunks, and crowns high enough to walk under.
- **Traffic without end.** The traffic (`traffic.ts`) is a pattern that repeats every 13 blocks along a street and every 14 streets across them, laid round wherever one looks from (`near`, `vehicleAt`; the shader's `nearTo`). Every street near by has its traffic; a lane comes round again far away, in the fog. The lights, the queues and nobody driving into anybody are as before (`traffic.test.ts`).
- **People on the pavements.** Some 1,300 walkers (600 on *Low*), two rings round each block — one each way — in a pattern of 9 × 9 blocks laid round the camera like the traffic (`city/walkers.ts`: who they are, each in their own clothes, hair and build, and `walkerAt`). **Near the camera** — within 55 m, the 24 nearest — they are **the office's own characters** (`CityWalkers.tsx`, the same `Character` the employees are), walking with their gait and turning at the corners; further off each is one simple shape moved by the graphics card from the time alone, and those near are hidden there (`cityLive.walkersNear`), so nobody is drawn twice. Only while the camera is down in the street.
- **What drives** (`city/vehicles.ts`): a saloon, an SUV, a yellow taxi with its roof sign and a city bus — each a side outline with rounded edges pushed out to its width, glass a little proud of it, bumpers, grille, mirrors, sills, lamps, tyres with rims; the bus with its band of lit windows. Every point says which part it is, so all of one kind is one draw with one material that colours by part. **Two levels of detail**: the vehicles within 160 m of the camera (chosen again every 0.3 s, a little wider than drawn) in the full shape, everyone else in a simple one of a few hundred points; each is drawn only in its band of distance. The car one drives is the same shape with a material for each part, and wheels of its own that roll and steer.

## How it is put together

```
OfficeScene ── Surroundings ── buildSkyline (skyline.ts)     the blocks round the camera, ground, traffic, walkers, lights
           └── Rig ─────────── outside? → cityFrame            step (explorer.ts), car in/out, camera, body
                    └────────── CityGear (city/gear.tsx)      the parachute, the car one drives, the car one left
```

- **`city/blocks.ts`** (pure): the grid (`PITCH` 116 m, streets 20 m wide, the street 150 m under the office floor), `blockAt`, `streetTrees`, `solidsNear`, `groundAt`, `blocked`.
- **`city/explorer.ts`** (pure): one state (`Explorer`: phase `fall | chute | foot | car`, position, speeds, the parachute's opening) and one step (`step`) from the keys; `leap` (out of the window), `board` and `alight` (the car).
- **`Rig.tsx`**: over the city the terrace (`plateOf(world)`, 25 cm inside its balustrade) is floor — `moveWithCollision(…, outdoor)` lets the owner walk there; within 1.1 m of its edge, outside the building, the prompt is "jump off the edge"; on going out it remembers where the owner stood (`home`) and starts a `leap` over the nearest edge. The terrace's paving is 1 cm under the office's floor, so one walks out of the door without a step. Each frame outside it runs `cityFrame` instead of the office's movement: the step, getting in and out of a car (the nearest vehicle of `cityTraffic`, found with `vehicleAt` from the same clock and the same origin the picture uses), the camera behind (pulled in front of any building between it and the body, kept under the trees on the street), the body's gait, and the gear. The office's own tower is one more solid with its top at 0: landing there is coming home.
- **`city/together.ts`**: one's own place out there (`ownerOutside`, sent with the presence) and the others' as drawn here (`othersOutside`); `rideNear`, `passengerSeat`, `besideOf` (see "Together").
- **Taking a car out of the traffic**: `cityLive.taken` (in `skyline.ts`) is the vehicle's index; the picture hides that instance (`aCar.w = -1`, and its lights) until another is taken or the owner is back.
- **The HUD** (`apps/desktop`): `outside`, `goOutside`, `backToOffice`, `outsideHint` in the store; the prompt at the bottom shows what the keys do just now and **Back to Office** (`[data-outside]`); `interact()` turns the window prompt into `goOutside`.

## Together

_Built on 2026-11-18 on the owner's request: "make the balcony jump multiplayer too, so the other players see everything and we can go together"._

Everybody sees everybody out there, and they can go about it together. A colleague and a visitor can go out too wherever they can walk the office (the window prompt is a thing of the scene, like a seat).

- **What is sent.** With its place, ten times a second while it moves, a window that is out in the city also says where it is there (`presence.out`, the type `OutsideAt` in `packages/contracts/src/outside.ts`): falling, under the parachute (and how far open), on foot, at the wheel (the car's body, paint, speed and steering), or riding with somebody (whose car); and the car it left in the street. The office cleans it (`cleanOutside`: only those phases, numbers held to the city, nothing else kept) and passes it on in `people` like the rest of the place. `x` and `z` stay where they jumped from in the office.
- **What is drawn.** `Humans.tsx` draws each other person where they are out there — the same world: the street is 150 m under the office's floor — so they are seen from the office falling past the windows and under their canopy, and from the street walking, driving, landing. Their parachute, their car and the car they left are `CityGear`, the very gear one's own window draws. At the wheel or riding, only the car is seen (and their name over it); no ring under them out there; their name tag is hidden when they are more than 320 m from the camera. `RemoteTrack` follows height as well, and takes what a car with Shift (40 m/s) or a fall covers between two reports as going, not as being put somewhere (`remote-motion.ts`).
- **Riding together.** On foot in the street, next to somebody who drives, F is "ride with …" (`rideNear` in `city/together.ts`, which `Humans.tsx` keeps filled with where the others are drawn here). One is then in the seat beside the driver (`passengerSeat`), the camera behind the car; F gets out, and one is put out when the driver gets out or goes home.
- **Going to somebody.** Out there, the bar at the bottom has **Go to …** for each other person out there (`joinOutside` in the store → `cityJoin` → `Rig.tsx`, `besideOf`). From the office one goes out first (the balustrade), then goes to them.
- **Voices and the whip.** People out there hear each other by where they are there (also up and down: under a canopy over somebody in the street is out of earshot), and the office does not hear the street nor the street the office (`apart` in `outside.ts`, used by the server's `hears` and by the window's loudness and the whip's crack). The whip reaches only somebody within 4.5 m out there, as in the office.

## Testing it

| Test | What it covers |
| --- | --- |
| `packages/office-3d/test/explorer.test.ts` | a block the same every time and nothing on the office's; buildings kept off the streets far away; out of the window: the parachute after 1.2 s, sinking slowly, landing on the street; a short drop without a parachute; not walking into a building; landing on a roof and falling off its edge (the parachute again); driving, turning, stopping at a building, getting out beside the car |
| `packages/office-3d/test/traffic.test.ts` | the traffic (see `SURROUNDINGS.md`) |
| `tests/ui/surroundings.mjs` (the Skyline step) | with real keys in the app: walking out on the terrace to the balustrade (which stops the walk) and its prompt, Space over it, **Back to Office** at once, the parachute by itself and its sink rate, the landing, "F — drive this car" beside a queue, F takes that car out of the traffic, it drives, F gets out and the car stays, the people near by are characters, kilometres away the city is built up all round, the button brings them back where they stood. **Together**, with a second window: it draws the owner under their parachute where they are, then their car driving (and not the owner beside it), and has where they are kilometres away; it goes out too, **Go to …** puts it beside the owner, "F — ride with …" next to the owner's car, riding along beside the driver, the owner's window shows the passenger in the car, out when the driver gets out, back in |
| `packages/contracts/test/outside.test.ts` | what the office keeps of `presence.out`, and how far apart two people are (in, out, between) |
| `packages/office-3d/test/together.test.ts` | whose car one can get into, the seat beside the driver, where "Go to" puts one (on foot, beside a car, in the air, on a roof, away from a wall) |
| `packages/office-3d/test/remote-motion.test.ts` | a car at speed and a fall followed evenly with their height; standing a while and then far off is being put there |
| `apps/server/test/voice.test.ts`, `tests/e2e/24-people-acts.test.ts` | voices by the street and not between the street and the office; through the door: `out` reaches the others cleaned, no voice or whip from the window down to the street, two in one car hear each other, back in clears it |

## Limits, plainly

- **The traffic is each window's own.** Its clock is the window's own, so the cars of the traffic are not where they are in somebody else's window; a car somebody took is drawn as theirs, and the car of the traffic it was still drives on in the other windows. The city and its buildings are the same for all.
- **One rides only in a car somebody drives**, one beside the driver (more riders sit in the same seat), and only somebody's car: not one they left standing.
- **"Go to" is only from out in the city** (and shows four people at most); from the office one jumps first.
- **Others are drawn some 300 ms behind** where they are (as in the office): beside a driver one sees the car as it was then — the seat goes with it — and their name tag in the air is a label that is not hidden by buildings.
- **Cars are not run into.** Your car drives through the traffic, through walkers and through each other's cars; walkers, and the others out there, walk through you. Only buildings stop anything.
- **Near people are chosen four times a second**: one crossing the 55 m line can show as the simple shape and the character for a moment, or neither.
- **The traffic goes straight on** and all the lights change together (as before); vehicles of the pattern come round again far off.
- **No damage, no falls that hurt.** A fall without a parachute lands on its feet.
- **Round towers are stood against as a square a little inside them**: near enough at a walk, a car can touch the curve.
- **Inside a narrow gap between two buildings** (they are built up to each other, 1.5–4 m apart) the camera has little room.
- **The keys are fixed** out there (F for the car, Space to jump or open the parachute), whatever the office's key settings say for F.
- **Only the Skyline** has a city to go down into.
