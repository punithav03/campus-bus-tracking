# Campus Bus

Live bus tracking for **Sri Venkatesa Perumal College of Engineering & Technology**, Puttur.

One question drives the whole product:

> *"My boarding point time is 07:05. Where is the bus?"*

The answer is not a dot on a map. It is a number that tells a student when to leave home,
and a system that is honest when it does not know.

---

## Route

**Nagalapuram → SVPCET** · 40.1 km · 19 stops · ~71 minutes

```
Nagalapuram Bus Stand · Gandhi Street · VKM Street · Indira Nagar · Krishnapuram
Ramagiri · Appambattu · Pichatur · Nindra X Road · Nindra · Nindra X Road (return)
Koppedu · Palamangalam · Chittoor Kandriga · Kailasakona · Vettalataduku
Narayanavanam · Puttur · SVPCET
```

The corridor is snapped to real roads and frozen to disk, so distances, stop positions
and the timetable are byte-identical on every build. 88% of it runs on named highways —
mostly Puttur–Uthukottai–Janappanchatram Road — with the Nindra spur driven in and back
out, exactly as the bus does.

Campus terminus: `13.43312, 79.50944`, inside the grounds rather than at the junction.

---

## How it works

Every GPS fix — from the phone on the bus or from a replayed trace — takes one path:

```
sanity filter → project onto route → alpha-beta smooth
    → stop geofences → ETA → snapshot for scoring
```

**Position is one number, not two.** A bus on a fixed route has a single meaningful
coordinate: how far along the route it is. Two noisy values collapse into one clean
scalar, and every question — which stop is next, has it passed me, how far to go —
becomes arithmetic.

The projection window is deliberately **asymmetric**: a little slack backwards for GPS
noise, and forwards only as far as top speed allows since the last fix. Routes double
back on themselves; a symmetric window lets a fix on the outbound leg match the return
leg, and a single overlap silently corrupts an entire trip.

**Arrivals are detected**, not assumed — a geofence plus a near-zero speed reading. Each
one is logged with its delay against schedule.

**The system scores itself.** Every ETA is recorded when made and compared against the
actual arrival. Errors are visible on the operations page, per model.

**It never overstates what it knows.** Each position carries its age. Under 30s it reads
*Live*; to 3 minutes *Recent*; to 10 minutes the marker ghosts and the position is
*Estimated*; beyond that the bus disappears and the timetable takes over. One stale
position presented as live costs a user permanently.

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

## Pages

| Path | For | Access |
|---|---|---|
| `/` | students | open |
| `/drive` | the phone on the bus | PIN |
| `/admin` | transport office | PIN |
| `/record` | route capture | PIN |

`ADMIN_PIN` is enforced server-side on every write. Without it nobody can start a trip or
post a position, so the bus cannot be faked. Private links stay hidden until a device
unlocks, and the auth check fails closed — an unreachable server is not permission.

---

## Deploy

```
render.com → New → Blueprint → select this repo → Apply
```

`render.yaml` carries the configuration. Set **ADMIN_PIN** when prompted. HTTPS is
provisioned automatically, which matters: browsers refuse geolocation without it.

Start command is `next start`. **Do not run `server.mjs` in production** — that is the
local host with a self-signed certificate, and the platform terminates TLS itself.

`data/routes` and `data/network.json` are committed; without them a deployment has no
route. `data/trips` and `data/recordings` are runtime only.

### Operational notes

- The instance sleeps when idle, so the first request of the morning takes about a minute.
  A scheduled request before the run removes it.
- Trip state is held in memory. A restart drops the in-flight trip; the bus re-registers
  on its next fix.
- Uploaded recordings do not survive a redeploy. Download them from `/admin` when they
  arrive — that page is a handover point, not an archive.

---

## Route data

The route was built from OpenStreetMap and verified, not drawn by hand.

```bash
npm run seed          # build the network (freezes the corridor on first run)
npm run seed:reroute  # re-route deliberately, after changing anchors
npm run villages      # match stop names to OSM village nodes
npm run roads         # report which roads the corridor actually uses
npm run diagnose      # replay a trace through the ingest filters
```

Stops carry coordinates where OpenStreetMap could confirm the village, and are
interpolated between confirmed neighbours otherwise — those are marked in the interface
rather than presented as surveyed. Where OSM and the college's own stop order disagreed,
the college won: a node placed 20 km off the sequence is worse evidence than the order
the route is actually driven in.

**Anchors shape the corridor; stops are projected onto it.** Routing through every stop
makes the router leave the highway and loop through village centres. A village 600 m from
the road is normal — the stop is where the road meets the village.

### Replacing the model with a recording

Positions and timings are currently modelled. One recorded ride replaces them with
measurements.

Browsers cannot record location in the background on Android — a page stops the moment
the screen locks. Use a native logger (GPS Logger, BasicAirData) with the *Always*
location permission and a 1-second interval, then:

```bash
npm run import-trace -- ride.gpx --id route-1 --names-from route-1
```

GPX and the in-app recorder format are both accepted. The importer cleans the fixes,
smooths and simplifies the path, detects every halt, and rebuilds the time profile.
`--names-from` keeps the college's stop names — it knows a stop is called
"Nindra X Road"; OpenStreetMap only knows which hamlet it sits in.

Validated against a known route: 17 of 17 stops recovered, 38.6 km against a true
38.7 km, 66 minutes against a true 66, from raw noisy GPS alone.

---

## Local development

```bash
npm install
npm run seed
npm run host        # localhost + LAN, with HTTPS for phone testing
```

`npm run host` prints a QR code. The HTTPS listener exists because `navigator.geolocation`
requires a secure origin — over plain HTTP on a LAN address, a phone is silently denied
GPS. Run `npm run cert` after switching networks.

Replay drives a recorded trace through the real ingest API at up to 40×, so the full
system can be exercised at any time of day without a bus.

---

## Stack

Next.js · React · MapLibre GL · OpenStreetMap tiles · OSRM and Nominatim at build time.

No database: route data is JSON on disk, trip state is in memory, fixes append to JSONL.
Nothing in the runtime path requires an account or an API key.
