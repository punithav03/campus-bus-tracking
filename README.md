# SVPCET Bus

Live bus tracking for **Sri Venkatesa Perumal College of Engineering & Technology**, Puttur.

One question drives the whole product:

> *"My boarding point time is 07:05. Where is the bus?"*

The answer is not a dot on a map. It is a number that tells a student when to leave home,
and a system that is honest when it does not know.

---

## Routes

The college runs nine buses. Every route is the transport office's own timing sheet
for 2026-27, with the stops, their order and their times exactly as given, drawn on
the real roads.

| # | Bus | Number | Driver | Starts | Stops | km | Recorded ride |
|---|---|---|---|---|---|---|---|
| 1 | Chittoor | AP03TD4149 | KBM Shafi | 07:50 | 16 | 61.4 | — |
| 2 | Penumur | AP03TB7775 | Yunis Basha | 07:50 | 14 | 46.5 | — |
| 3 | Chandragiri | AP39WQ4798 | A Eswar | 07:20 | 21 | 53.2 | — |
| 4 | Srikalahasti | AP39WG7958 | Manikanta | 07:40 | 13 | 62.2 | — |
| 5 | Nagalapuram | AP39WG5135 | Yogesh | 08:05 | 14 | 38.9 | yes |
| 6 | Vijayapuram | AP03TB7778 | Yugandhar | 07:10 | 21 | 60.2 | yes |
| 7 | Tirupati | AP39WQ4796 | J Shankar | 07:45 | 20 | 52.2 | yes |
| 8 | Sathrawada | AP03TD9639 | A Antony | 08:00 | 14 | 39.3 | — |
| 9 | KVB Puram | AP03TD9149 | V Sudhakar | 07:30 | 16 | 45.8 | yes |

The college (`13.43359, 79.50965`, inside the grounds) is the last stop of every route.

Not every stop is known equally well, and the app says so rather than pretending:

- **Verified.** Pinned by hand, seen on a recorded ride, or a mapped bus stop.
- **Found by name.** An OpenStreetMap village whose name matches the sheet. It is
  probably right, but unproven. The app allows more room before calling it served
  or skipped, and never pushes "your stop was skipped" for one.
- **Approximate (`~`).** Nobody could place it yet (Gangamma Gudi, Desamma Gudi,
  Addalameda…), so it sits on the road between its neighbours in proportion to
  their times. Shown with a `~`.
- **Not on timetable.** A pickup point students wrote down that the office's sheet
  does not list (Crime Police Station, Arai, Chillies…). It was found on the road
  that bus drives, and added with a time worked out from the stops either side.
  The office still has to confirm the bus stops there.

`data/official/build-report.md` lists every stop with what placed it.

---

## How it works

Every GPS fix — from the phone on the bus or from a replayed trace — takes one path:

```
sanity filter → match to the real road → progress against the plan
    → stop states → ETA → snapshot for scoring
```

**The map shows the road the bus actually drove — not the plan.** Earlier versions
worked out how far along the planned route the bus was and drew it at that distance
along the planned line. That breaks the moment the bus leaves the plan. The Nagalapuram
bus turns off the main road after Keelapudi, runs out to Nindra and comes back to the
same junction; when nobody is waiting there the driver carries straight on — and the old
map walked the bus down the spur and back anyway, five kilometres of fiction, marking
Nindra as served. Village spurs like it are on most of the nine routes.

So the engine now keeps three questions apart:

| Question | Answered by |
|---|---|
| **Where is it?** | The GPS fixes matched to the real road network (see *Road matching* below). Drawn wherever the bus really is, on the plan or off it. |
| **How far along?** | Progress against the planned route, for ETAs and the timetable. It may **jump forward** — the bus turned up further along than it could have driven, which is what a skipped spur looks like — and it simply **waits** while the bus is somewhere the plan does not go. A jump is only believed after three consecutive fixes agree on it. |
| **What happened at each stop?** | Observed, never inferred from distance. `served` — the bus halted there or was seen going past. `skipped` — progress jumped over it and the road the bus actually drove never came near it. `likely-skipped` — off its route for 2+ minutes, 800 m further from the stop than its closest approach, and still pulling away. `upcoming` — not reached. |

Out-and-back spurs are told apart by **direction**: a bus on the spur road matches the
way in or the way out by which way it is heading, because the two legs run in opposite
directions.

**No driver input.** Nothing has to be tapped when a stop is skipped — the skip is seen
within about ten seconds of the bus passing the turning. Students whose stop is skipped
get a push notification saying so; "likely skipped" is shown on screen but never pushed,
because a notification cannot be taken back.

**When it is off its route**, the line ahead is the road from the bus to the next stop it
can still serve (routed on the road graph, drawn dashed), then the plan from there; the
ETA is that road distance at the speed the bus has actually been doing, then the usual
profile. A dead zone is drawn as a gap in the line, never bridged with a guess.

### Road matching

Every road within 3 km of each route, and every main road within 12 km, is cut from the
local OpenStreetMap extract and committed as `data/roads/<bus>.roads.json`, the same way
route geometry is kept: 0.5–2 MB a route, about a third of that gzipped, all nine
together ~175 MB of server memory. Matching runs **inside the app**: no map-matching
server, no VPS, nothing to go down mid-run, ₹0.

The matcher is a hidden Markov model (Newson & Krumm), solved online with a fixed lag of
about 60 seconds. A single fix cannot say which road it is on — at 10 m of error a fix
near a fork is equally close to both — but a minute of fixes can, because the bus has to
be able to drive from each position to the next in the time between them. The newest
minute is drawn too and may be redrawn as more fixes arrive; older stretches are settled
and stored. Bursts of bad fixes are absorbed rather than followed, and anywhere no known
road explains the fixes they are drawn as raw GPS, dashed.

Against the real recorded ride on the Nagalapuram line: the whole 75-minute run matches in about a
tenth of a second, as one continuous line, with the matched position a median 3.4 m from
the raw fix. The phone's GPS was always good; the problem was the app throwing it away.

A route without a road file still works — positions are the raw fixes, joined up and
marked unverified — so building the files is an improvement, never a dependency.

**Arrivals are detected**, not assumed — a geofence plus a near-zero speed reading, or the
bus seen crossing the stop between two fixes. Each one is logged with its delay against
schedule; skipped stops are logged too, without a time.

**The system scores itself.** Every ETA is recorded when made and compared against the
actual arrival. Errors are visible on the operations page, per model.

**It never overstates what it knows.** Each position carries its age. Under 30s it reads
*Live*; to 3 minutes *Recent*; to 5 minutes the marker ghosts and the position is
*Estimated*; beyond that the bus disappears and the timetable takes over. Between fixes
the marker is carried forward along the real road for at most 15 seconds, and only while
the bus is on its route. One stale position presented as live costs a user permanently.

---

## Accuracy

Two ETA models run side by side on the identical fix stream.

| Model | Method |
|---|---|
| **Route profile** | how long this stretch has taken before, rescaled to today's pace |
| **Naive** | remaining distance ÷ current speed — what most bus trackers ship |

Measured over a full route, scored against real arrivals:

```
route profile     16 s
naive            127 s
```

The naive figure is not a strawman. Dividing by current speed means every junction and
every stop sends it lurching — it swung from 48 min to 136 min for the same stop during
one run, while the profile model moved from 37 to 35.

Pace is judged from a recent window rather than the whole trip, because **being late is
not the same as being slow**. A bus delayed by traffic it has already cleared should not
keep inflating every remaining estimate. The two measures are blended by how much they
disagree: agreement means conditions are steady and the smoother estimate leads;
divergence means something changed and only the recent window knows.

Tested against a trip with a ten-minute jam the reference never saw:

```
adaptive        215 s
whole-trip      251 s
naive           250 s
```

Near-optimal on a normal day, materially better on a bad one. The worst case is what
users judge the service by.

---

## Notifications

Built like the delivery and ride-hailing apps: **one card per trip** that keeps itself
current, not a stream of separate messages.

- The card shows minutes to your stop, stops away, where the bus is now and the
  arrival time, with a picture of the route and the bus on it (expanded view on Android).
- It **updates quietly** when the minutes or stops change (at most every 45 seconds),
  and **buzzes only when you have to act**: the bus has started, *leave now* (your own
  warning time), *arriving* (next stop is yours), *at your stop*, *did not come to your
  stop*, and *reached the college*. Each moment is announced once; the database row
  is the lock.
- **Track live** and **I'm at the stop** buttons work right from the notification.
- Alerts go out at high urgency, so a phone in battery saver still wakes for them.
  Updates carry a topic, so a phone that was offline gets only the newest one.
- A skip is only announced when it is certain: a verified stop, passed by over 500 m.
  Anything less is shown in the app and never pushed.
- **Send a test** (home screen, once notifications are on) sends a sample card through
  the real push service, so a student knows it works before the morning it matters.

Web apps cannot use Android 16's native "Live Updates" progress template or iOS Live
Activities; this is the closest the web gets, and it works the same in the installed
app and the browser. On iPhone, notifications need the app added to the home screen.

For testing without a phone: `PUSH_DRY_RUN=1 PUSH_ON_REPLAY=1 npm run dev`, start a
demo run from the office screen, and every card that would be sent is written to
`data/push-dry-run.jsonl`.

---

## Pages

| Path | For | Sign in with |
|---|---|---|
| `/` · `/track` | students | admission number |
| `/drive` | the phone on the bus | driver's mobile number |
| `/admin` | transport office | `admin` |
| `/record` | route capture | driver or office |

One login box for everyone; the server works out who you are. The first password is the
admission number (students) or the mobile number (drivers), and it opens the app straight
away; anyone can change it in Settings (the new one cannot be the ID). A forced change on
first sign-in exists but is switched off at the college's request — set
`FORCE_PASSWORD_CHANGE` in `src/lib/session.ts` to bring it back. A student or driver only ever sees their own bus: the route
comes from the signed session, never from the request. Five wrong passwords lock an ID
for ten minutes.

---

## Deploy

```
render.com → New → Blueprint → select this repo → Apply
```

`render.yaml` carries the configuration. Set **ADMIN_PIN** when prompted. HTTPS is
provisioned automatically, which matters: browsers refuse geolocation without it.

Start command is `next start`. **Do not run `server.mjs` in production** — that is the
local host with a self-signed certificate, and the platform terminates TLS itself.

`data/routes`, `data/roads`, `data/network.json`, `data/official` and `public/maps` are
committed; without them a deployment has no routes and no map. `data/private` (student
names) is not, and must never be: the repo is public. `data/trips` and `data/recordings`
are runtime only.

**Putting the real data in the live database** (once, then after each new list):

```bash
DATABASE_URL=<neon pooled url> npm run db:seed -- --prune
```

`--prune` removes the old three demo routes and their accounts. Students and drivers
are created with their first password as above. Set `ADMIN_PASSWORD` in the
environment first, or the office login is the default printed in this repo.

### Operational notes

- The instance sleeps when idle, so the first request of the morning takes about a minute.
  A scheduled request before the run removes it.
- Live trip state is held in memory and mirrored to the database every 15 seconds —
  position, stop arrivals, skipped stops and the trail drawn so far — so a restart
  mid-run picks the bus back up where it was.
- A trip is closed for silence only after 45 minutes. It used to be four, which closed
  trips behind the backs of buses in dead zones and then refused every buffered fix
  when the phone came back into signal.
- Uploaded recordings do not survive a redeploy. Download them from `/admin` when they
  arrive — that page is a handover point, not an archive.

---

## The map

The basemap is **our own**: one PMTiles file covering the whole bus area, from
Tirupati to Chittoor and from Srikalahasti to Nagalapuram, cut from the Protomaps
build of OpenStreetMap (data of 18 Oct 2026). It is 12 MB, lives in `public/maps/`
next to its fonts and icons, and is served by this app itself. That means:

- **No tile server, no API key, no usage limit, ₹0.** Nothing outside this app has
  to be up for the map to draw.
- **It works with no signal.** The service worker keeps a full copy on the phone
  after the first visit and answers each tile from it. The map file's name carries
  the data date, so a new file is a new URL and no cache can serve a stale one.
- **One look everywhere**, light or dark (`SVPCET map` in the style picker). The
  public OpenFreeMap / VersaTiles styles are still offered as alternatives.

Refresh it once a semester, when new roads have been mapped:

```bash
pmtiles extract https://build.protomaps.com/<YYYYMMDD>.pmtiles \
  public/maps/svpcet-<YYYYMMDD>.pmtiles --bbox=78.95,13.05,79.95,13.90
# then set MAP_FILE in src/lib/basemap.ts and delete the old file
```

The bus moves continuously. Between readings it is carried along the road it is
actually on at the speed it was doing, and corrected smoothly when the next reading
lands. **3D** gives the satnav view: tilted, turning with the bus, road ahead up.
**Follow bus** takes the camera back however the map was moved.

---

## Route data: from the office's sheets to the app

Everything is rebuilt from the office's files with four commands, all on this laptop:

```bash
# 1. The office's spreadsheets -> JSON (stops and times exactly as given)
python -I tools/import_official.py "Transport Route timings 2026-27.xlsx" "student list.xlsx"
#    data/official/transport.json   committed: buses, drivers, stops, times
#    data/private/students.json     NOT committed: names stay out of a public repo

# 2. OpenStreetMap for the area -> roads + named places (once a semester)
#    from https://download.openstreetmap.fr/extracts/asia/india/ (AP + Tamil Nadu, ~220 MB)
python -I tools/osm_extract.py <osm-dir> andhra_pradesh-latest.osm.pbf tamil_nadu-latest.osm.pbf

# 3. Every route: stops placed, road drawn, timetable, roads for live matching
npm run routes                 # or: npm run routes -- tirupati
#    reads OSM_DIR (default C:/Users/yokes/osm-data)

# 4. The database: routes, stops, drivers, students
npm run db:seed                # add --prune to drop old routes and accounts
```

**How a stop is placed.** A hand pin in `data/official/stop-hints.json` wins.
Otherwise the OpenStreetMap places whose names match, spelling-proofed
("Pichchatur" = "Pichatoor" = "PICHATTUR"). Most names match several villages
across the district. The one chosen is the one that makes the whole route make
sense, with each stop reachable from the last in the time the sheet allows; it is
solved over the whole route at once, not stop by stop. Anything still unplaced sits
between its neighbours by time.

**How the road is drawn.** Stop to stop over the real road network, with speeds for
a bus rather than a car, so the line stays on main roads. Where a ride has been
recorded (`data/traces/<bus>-*.gpx`), roads the bus was seen on are strongly
preferred, so the line follows what the bus does rather than what a router guesses.
A village beside the main road is served from the main road; the bus only drives in
when the village is further off than that.

**Roads for live matching.** Each route gets every road within 3 km plus every main
road within 12 km (`data/roads/<bus>.roads.json`, 0.5–2 MB each). A bus that leaves
its route is still on a known road, and the line ahead is re-routed from wherever it
is, the way a navigation app does.

**Students.** Each student is put on their bus and on the stop their pickup point
matches (with obvious spellings: Tiruchanur = Tiruchanoor). Pickup points not on
the sheet are looked for on that bus's road and added as stops when found. Students
whose point cannot be placed keep their bus and pick their stop on first sign-in.
The office sees every such case on the fleet screen under **students to confirm**,
next to what the student wrote.

### Adding a recorded ride

A recording is the single best improvement to a route. Use a native logger (GPS
Logger by BasicAirData, 1-second interval, battery unrestricted), save the GPX as
`data/traces/<bus>-<date>-<morning|evening>.gpx`, and run `npm run routes -- <bus>`.
The road line snaps to what the bus actually drove. Evening rides work too:
direction does not matter for the road. Add a pin to `stop-hints.json` for any halt
that is a stop.

---

## Local development

```bash
npm install
# a database of your own, so nothing touches the live one
docker run -d --name svpcet-pg -e POSTGRES_PASSWORD=local -e POSTGRES_DB=bus -p 5433:5432 postgres:16
export DATABASE_URL=postgres://postgres:local@localhost:5433/bus
npm run db:seed
npm run dev         # http://localhost:3100
npm test            # 4 suites, 280 checks — needs the dev server running
npm run host        # localhost + LAN, with HTTPS for phone testing
```

The tests make their own accounts (one student and one driver per bus) and remove them
afterwards; they refuse to run against anything but a local database.

`npm run host` prints a QR code. The HTTPS listener exists because `navigator.geolocation`
requires a secure origin — over plain HTTP on a LAN address, a phone is silently denied
GPS. Run `npm run cert` after switching networks.

Replay drives a recorded trace through the real ingest API at up to 40×, so the full
system can be exercised at any time of day without a bus.

---

## Stack

Next.js · React · MapLibre GL · Protomaps (self-hosted PMTiles) · OpenStreetMap ·
Postgres (Neon) · Web Push · Capacitor for the driver's Android app.

People and history live in Postgres; route geometry is JSON committed with the code;
live positions stay in memory and are mirrored to the database every 15 seconds. Nothing
in the runtime path needs a third-party account or an API key — not even the map.
