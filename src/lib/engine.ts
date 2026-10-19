/**
 * The live position + ETA engine.
 *
 * Every GPS fix — from a phone on the bus, a rider broadcasting, or replay of a
 * recorded trip — enters through `ingest()` and takes the identical path:
 *
 *     sanity filter -> match to the road -> progress against the plan
 *       -> stop states -> ETA (naive + profile) -> snapshot for scoring
 *
 * Because seed data, replay and real phones all share this path, anything that
 * works in the demo works on a real bus.
 *
 * TWO DIFFERENT QUESTIONS, KEPT APART
 *
 * This engine used to answer "where is the bus?" with "how far along the plan
 * is it?", and then draw it at that distance along the planned line. That is
 * fine while the bus follows the plan and badly wrong the moment it does not.
 * Route 1 turns off the main road at 10.2 km, runs out to Nindra and comes
 * back to the same junction at 15.1 km. On a morning nobody is waiting at
 * Nindra the driver carries straight on — and the app walked the marker down
 * the spur and back regardless, five kilometres of fiction, and marked both
 * Nindra stops served on the way. There are eleven spurs like it across the
 * three routes.
 *
 * So now:
 *
 *   WHERE IS IT     the matched road position (matcher.ts) — the real road
 *                   under the real fixes, wherever that is, plan or no plan
 *   HOW FAR ALONG   progress against the plan, for ETAs and the timetable.
 *                   It is allowed to JUMP forward when the bus turns up
 *                   further along the plan than it could have driven — that
 *                   is what a skipped spur looks like — and it simply waits
 *                   while the bus is somewhere the plan does not go.
 *   WHAT HAPPENED   a stop is served only when the bus was SEEN there. A stop
 *                   the progress jumped over is skipped, unless the road the
 *                   bus actually drove passed by it.
 */

import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atDistance, bearingAt, clamp, haversine, planHits } from './geo';
import { getRoute, type LoadedRoute } from './network';
import { getRoadGraph, routeBetween } from './roadgraph';
import { Matcher, RawTracker, GAP_S, type PathTracker, type TrailSeg } from './matcher';
import type {
  Confidence, EtaSnapshot, Ping, PingSource, StateView, StopEvent, StopState, StopView,
  TrailView, TripView,
} from './types';

// ------------------------------------------------------------------ tuning

const MAX_ACCURACY_M = 75;    // bin fixes worse than this outright
const MAX_SPEED_MPS = 30;     // 108 km/h — impossible for a college bus

/** A fix implying more than this since the last one is a glitch, not a bus. */
const TELEPORT_MPS = 60;

/** Within this of the planned line counts as on the plan. */
const ON_PLAN_M = 45;
/** Plan passes running more than this far from the bus's heading are not it. */
const HEADING_TOL = 70;
/** A heading older than this no longer says which way the bus is facing. */
const HEADING_TTL_MS = 15_000;
/** Below this the bus is standing; its "heading" is GPS noise. */
const MOVING_MPS = 2;
/**
 * Heading is measured across at least this much movement. Across one fix —
 * seven metres at town speed — a single wobble can point it backwards, and a
 * backwards heading does not match the plan, so the bus "left its route" for
 * a fix at a time, fourteen times on one ride, while sitting on it.
 */
const HEADING_BASE_M = 20;
/** Consecutive fixes that must fail to fit the plan before it counts as off it. */
const OFF_PLAN_FIXES = 3;
/** Slack behind the current progress when looking for the plan. */
const PROJECT_BACK_M = 80;

/**
 * A forward jump in progress is only believed after this many consecutive
 * fixes agree on it, across at least this much real movement. One fix can be
 * a glitch at a junction; three fixes, driving, cannot.
 */
const JUMP_FIXES = 3;
const JUMP_MOVED_M = 25;

/**
 * "Probably skipping your stop" is said to a student standing at it, who may
 * walk away on the strength of it. So it is said late and only on strong
 * evidence: off the route for at least LIKELY_SKIP_S, at least LIKELY_SKIP_M
 * further from the stop than its closest approach, AND still pulling away —
 * further now than a minute ago by LIKELY_AWAY_M. A bus on a loop that comes
 * back round fails the last test the moment it turns for home.
 */
const LIKELY_SKIP_S = 120;
const LIKELY_SKIP_M = 800;
const LIKELY_AWAY_M = 150;

const ALPHA = 0.45;           // position correction per residual
const BETA = 0.09;            // velocity correction per residual

const ARRIVE_SPEED_MPS = 1.6;
const SNAPSHOT_EVERY_S = 20;

// Naive ETA divides by current speed. Below this floor the number explodes to
// infinity, so every real implementation clamps — and the clamp is exactly why
// naive ETAs lurch every time a bus slows for a junction.
const NAIVE_FLOOR_MPS = 2.5;

type RouteStop = LoadedRoute['stops'][number];
interface Where { lng: number; lat: number; t: number }

// ------------------------------------------------------------------- trip

class Trip {
  id: string;
  routeId: string;
  startedAt: number;              // epoch ms, from the first accepted fix

  /**
   * Replay feeds real fix timestamps faster than real time, so the engine sees
   * correct speeds while the device clock outruns the wall clock. These map it
   * back for display: everything shown to a user is wall-clock time.
   */
  clockOrigin = 0;
  clockScale = 1;
  status: 'running' | 'finished' = 'running';
  /** Set once the ticker has written a finished trip's final state. */
  flushed = false;

  // ---- where it is ------------------------------------------------------
  readonly tracker: PathTracker;
  pos: { lng: number; lat: number } | null = null;
  heading: number | null = null;
  private headingAt = 0;
  /** Recent matched positions, for a heading taken across real distance. */
  private recent: Where[] = [];
  /** Consecutive fixes that did not fit the plan. */
  private misfits = 0;
  onRoad = false;

  // ---- how far along the plan -------------------------------------------
  distAlongM = 0;
  speedMps = 0;
  rawSpeedMps = 0;
  onPlan = true;
  offPlanSince: number | null = null;
  /**
   * Metres actually driven, along the matched road. Not the same as progress
   * along the plan: after a skipped spur progress jumps five kilometres the
   * bus never drove, and "Travelled 15.2 km" would be a lie.
   */
  drivenM = 0;
  /**
   * Reference seconds of the route actually DRIVEN. Equal to the reference
   * time at the current progress, until the bus skips something — then it
   * stops counting the part it skipped. Pace is measured against this, or a
   * skipped ten-minute spur would make the bus look ten minutes faster than
   * it is and drag every remaining ETA early.
   */
  refDriven = 0;
  private pending: { d: number; n: number; moved: number } | null = null;
  /** Real positions since progress last moved normally — the evidence for a jump. */
  private sincePlan: Where[] = [];
  /** Off the plan: the nearest each upcoming stop has been. */
  private nearest = new Map<number, number>();
  /** Off the plan: distance to each watched stop, sampled every 10 s. */
  private away = new Map<number, { t: number; d: number }[]>();
  /** Cached road route to where the bus can rejoin, while off the plan. */
  private aheadCache: {
    seq: number; at: { lng: number; lat: number }; t: number;
    distM: number | null; coords: [number, number][] | null;
  } | null = null;

  lastFixAt = 0;                  // device clock of the last accepted fix
  lastSeenAt = 0;                 // server clock — drives the freshness badge
  source: PingSource = 'device';

  pingCount = 0;
  rejectedCount = 0;

  events: StopEvent[] = [];
  /** Stops decided skipped: seq -> device time it was decided. */
  skipped = new Map<number, number>();
  /**
   * For each skipped stop, the closest the bus actually came to it, when
   * known. A bus that went by 2 km away certainly did not come; one that went
   * by 200 m away may well have picked students up at the main road while the
   * stop's pin sits in the village. Only the first is certain enough to push.
   */
  skippedByM = new Map<number, number>();
  private openStop: { seq: number; arrivedAt: number } | null = null;
  snapshots: EtaSnapshot[] = [];
  private lastSnapshotAt = -1e9;

  /** (elapsedS, distAlongM, refDriven) every 10 s, for pace and the admin chart. */
  track: { t: number; d: number; r: number }[] = [];

  constructor(id: string, routeId: string, startedAt: number) {
    this.id = id;
    this.routeId = routeId;
    this.startedAt = startedAt;
    const g = getRoadGraph(routeId);
    this.tracker = g ? new Matcher(g) : new RawTracker();
  }

  get elapsedS() {
    return Math.max(0, (this.lastFixAt - this.startedAt) / 1000);
  }

  private served(seq: number) { return this.events.some((e) => e.seq === seq); }
  private decided(seq: number) { return this.served(seq) || this.skipped.has(seq); }

  accept(route: LoadedRoute, p: Ping, source: PingSource): boolean {
    // ---- sanity filters -------------------------------------------------
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) return false;
    if (p.acc != null && p.acc > MAX_ACCURACY_M) return false;
    if (p.spd != null && p.spd > MAX_SPEED_MPS) return false;

    const first = this.pingCount === 0;
    if (!first && p.t <= this.lastFixAt) return false; // out of order / duplicate
    const dtS = first ? 1 : Math.max(0.25, (p.t - this.lastFixAt) / 1000);
    if (!first && this.pos && dtS < 60 &&
        haversine(this.pos, p) / dtS > TELEPORT_MPS) return false;

    // ---- where is it, really --------------------------------------------
    const prevPos = this.pos;
    const m = this.tracker.push(p.t, p.lng, p.lat, p.acc);
    this.pos = { lng: m.lng, lat: m.lat };
    this.onRoad = m.onRoad;
    const step = m.stepM ?? (prevPos ? haversine(prevPos, this.pos) : 0);
    // Only a MOVING bus has a direction. A bus halted at a stop still jitters
    // a few metres up and down the road, and each wobble reads as a heading —
    // half of them backwards. Trusting those flipped it off its route while it
    // stood still, every few seconds, right when a stop was being served.
    const moving = (p.spd ?? step / dtS) >= MOVING_MPS;
    this.recent.push({ ...this.pos, t: p.t });
    while (this.recent.length > 2 && p.t - this.recent[0].t > 30_000) this.recent.shift();
    if (moving) {
      const h = headingAcross(this.recent, HEADING_BASE_M);
      if (h != null) { this.heading = h; this.headingAt = p.t; }
      else if (p.heading != null) { this.heading = p.heading; this.headingAt = p.t; }
    }
    const heading = this.heading != null && p.t - this.headingAt < HEADING_TTL_MS ? this.heading : null;
    if (!first) this.drivenM += Math.min(step, 3000);
    const here: Where = { ...this.pos, t: p.t };

    const distBefore = this.distAlongM;
    const fixBefore = this.lastFixAt;
    if (first) this.startedAt = p.t;
    this.lastFixAt = p.t;
    this.lastSeenAt = Date.now();
    this.source = source;
    this.pingCount++;
    this.rawSpeedMps = p.spd ?? step / dtS;

    // ---- how far along the plan -----------------------------------------
    const hits = planHits(
      route.shape, route.cum, this.pos,
      first ? 0 : this.distAlongM - PROJECT_BACK_M, route.lengthM,
      ON_PLAN_M, heading, HEADING_TOL,
    );
    // The EARLIEST pass the bus could be on. On a spur, the way in comes
    // before the way out, and the heading has already ruled out the leg it
    // is not driving.
    const hit = hits[0] ?? null;

    if (!hit && this.onPlan && !first && ++this.misfits < OFF_PLAN_FIXES) {
      // Not yet. One or two fixes that do not fit are far more often noise
      // than a bus turning off; hold progress and see what the next says.
      this.sincePlan.push(here);
    } else if (!hit) {
      this.leavePlan(route, here, dtS, step);
    } else {
      this.misfits = 0;
      const gain = hit.distAlong - this.distAlongM;
      // How much progress the road actually driven can account for. Straight
      // on from a fix that was on the plan, it is the distance driven plus
      // slack; coming back from somewhere off the plan, nothing beyond a
      // little noise — every metre of plan between where it left and where it
      // rejoined is plan it did not drive.
      const allowed = this.onPlan ? step * 1.5 + 60 : 120;

      if (first || gain <= allowed) {
        this.advance(route, hit.distAlong, dtS, p, distBefore, fixBefore, first);
      } else {
        this.sincePlan.push(here);
        const pd = this.pending;
        if (pd && Math.abs(hit.distAlong - pd.d) < 150 + step * 1.5) {
          pd.n++; pd.moved += step; pd.d = hit.distAlong;
        } else {
          this.pending = { d: hit.distAlong, n: 1, moved: 0 };
        }
        if (this.pending!.n >= JUMP_FIXES && this.pending!.moved >= JUMP_MOVED_M) {
          this.jump(route, hit.distAlong, p.t);
        }
      }
    }

    // The college is the college, whichever road the bus took to get there.
    const terminus = route.stops[route.stops.length - 1];
    if (!this.served(terminus.seq) &&
        haversine(this.pos, terminus) <= terminus.geofenceM) {
      this.record(terminus, p.t, Math.min(this.speedMps, this.rawSpeedMps) <= ARRIVE_SPEED_MPS);
    }

    this.maybeSnapshot(route);

    const el = this.elapsedS;
    if (!this.track.length || el - this.track[this.track.length - 1].t >= 10) {
      this.track.push({ t: Math.round(el), d: Math.round(this.distAlongM), r: Math.round(this.refDriven) });
    }
    // A trip is over when the LAST STOP has been served, not when the bus is
    // merely near the end of the line. Ending it 30 m early meant the final
    // stationary fixes at the campus were refused as trailing pings, so the
    // arrival there was never recorded at all.
    if (this.served(terminus.seq) ||
        (this.onPlan && this.distAlongM >= route.lengthM - 5 && this.speedMps < 0.5)) {
      this.finish(route);
    }
    return true;
  }

  /** Normal progress: on the plan, moving the way the plan goes. */
  private advance(
    route: LoadedRoute, d: number, dtS: number, p: Ping,
    distBefore: number, fixBefore: number, first: boolean,
  ) {
    if (first) {
      this.distAlongM = d;
      this.speedMps = p.spd ?? 0;
      this.refDriven = 0;
    } else if (!this.onPlan) {
      // Back from a short excursion. Pick up from where it actually is rather
      // than smoothing towards it from where it left.
      this.distAlongM = Math.max(this.distAlongM, d);
    } else {
      // ---- alpha-beta smoothing on (distance, speed) --------------------
      const predicted = this.distAlongM + this.speedMps * dtS;
      const residual = d - predicted;
      this.distAlongM = predicted + ALPHA * residual;
      this.speedMps = clamp(this.speedMps + (BETA / dtS) * residual, 0, MAX_SPEED_MPS);
    }
    this.distAlongM = clamp(this.distAlongM, 0, route.lengthM);
    if (!first && this.distAlongM > distBefore) {
      this.refDriven += Math.max(0, refTimeAt(route, this.distAlongM) - refTimeAt(route, distBefore));
    }

    this.onPlan = true;
    this.offPlanSince = null;
    this.pending = null;
    this.nearest.clear();
    this.away.clear();
    this.aheadCache = null;
    this.sincePlan = this.pos ? [{ ...this.pos, t: this.lastFixAt }] : [];

    this.detectStopEvents(route, first ? this.distAlongM : distBefore, first ? p.t : fixBefore);
  }

  /**
   * The bus is somewhere the plan does not go. Progress waits; the position
   * does not — it is drawn where it is. Upcoming stops are watched two ways:
   * one it drives up to is served, and one it keeps getting further from is
   * probably being skipped.
   */
  private leavePlan(route: LoadedRoute, here: Where, dtS: number, step: number) {
    if (this.onPlan) { this.onPlan = false; this.offPlanSince = here.t; }
    this.pending = null;
    this.sincePlan.push(here);
    if (this.sincePlan.length > 4000) this.sincePlan.splice(0, 1000);
    // No progress to smooth, so speed comes from the movement itself.
    this.speedMps = clamp(this.speedMps * 0.7 + (step / dtS) * 0.3, 0, MAX_SPEED_MPS);

    for (const s of this.upcoming(route).slice(0, 3)) {
      const d = haversine(here, s);
      if (d <= serveRadius(s)) {
        this.record(s, here.t, this.speedMps <= ARRIVE_SPEED_MPS);
        continue;
      }
      this.nearest.set(s.seq, Math.min(this.nearest.get(s.seq) ?? Infinity, d));
      const log = this.away.get(s.seq) ?? [];
      if (!log.length || here.t - log[log.length - 1].t >= 10_000) {
        log.push({ t: here.t, d });
        if (log.length > 30) log.shift();
        this.away.set(s.seq, log);
      }
    }
  }

  /**
   * Progress jumps forward: the bus has turned up further along the plan than
   * the road it drove could account for. Every stop in between is decided by
   * the evidence — did the road the bus actually drove pass by it?
   */
  private jump(route: LoadedRoute, to: number, at: number) {
    const from = this.distAlongM;
    const path = this.evidencePath();
    for (const s of route.stops) {
      if (s.distAlongM <= from || s.distAlongM > to || this.decided(s.seq)) continue;
      const near = closestOnPath(path, s);
      if (near && near.d <= skipRadius(s)) this.record(s, near.t, false);
      else {
        this.skipped.set(s.seq, at);
        if (near) this.skippedByM.set(s.seq, Math.round(near.d));
      }
    }
    this.distAlongM = to;
    this.onPlan = true;
    this.offPlanSince = null;
    this.pending = null;
    this.openStop = null;
    this.nearest.clear();
    this.away.clear();
    this.aheadCache = null;
    this.sincePlan = this.pos ? [{ ...this.pos, t: at }] : [];
  }

  /**
   * The road driven since progress last moved normally. Where the phone went
   * silent, the gap is filled with the shortest road route between the two
   * ends — never drawn, only used to judge whether the bus could have gone
   * past a stop in the dark.
   */
  private evidencePath(): Where[] {
    const g = getRoadGraph(this.routeId);
    const out: Where[] = [];
    for (const w of this.sincePlan) {
      const prev = out[out.length - 1];
      if (g && prev && (w.t - prev.t) / 1000 > GAP_S) {
        const r = routeBetween(g, [prev.lng, prev.lat], [w.lng, w.lat]);
        if (r) {
          const n = r.coords.length;
          r.coords.forEach(([lng, lat], k) => {
            if (k > 0 && k < n - 1) out.push({ lng, lat, t: prev.t + ((w.t - prev.t) * k) / (n - 1) });
          });
        }
      }
      out.push(w);
    }
    return out;
  }

  private finish(route: LoadedRoute) {
    if (this.status === 'finished') return;
    this.status = 'finished';
    // Anything never reached by the time the bus is at the college was skipped.
    for (const s of route.stops) {
      if (!this.decided(s.seq)) this.skipped.set(s.seq, this.lastFixAt);
    }
    this.tracker.close();
  }

  /** Stops not yet served or skipped, in route order. */
  private upcoming(route: LoadedRoute): RouteStop[] {
    return route.stops.filter((s) => !this.decided(s.seq));
  }

  /** Off the plan, well away from this stop and still pulling away: probably not going there. */
  likelySkipped(s: RouteStop): boolean {
    if (this.onPlan || this.offPlanSince == null || !this.pos) return false;
    // Too unsure where an approximate stop even is to say it is being missed.
    if (s.estimated) return false;
    if ((this.lastFixAt - this.offPlanSince) / 1000 < LIKELY_SKIP_S) return false;
    const best = this.nearest.get(s.seq);
    const now = haversine(this.pos, s);
    if (best == null || now - best < LIKELY_SKIP_M) return false;
    const log = this.away.get(s.seq);
    const then = log?.find((e) => this.lastFixAt - e.t <= 70_000 && this.lastFixAt - e.t >= 50_000);
    return !!then && now - then.d >= LIKELY_AWAY_M;
  }

  /**
   * Records the moment the bus served each stop, while it moves along the plan.
   *
   * Two detectors, because one is not enough:
   *
   *  · HALT — inside the geofence and nearly stopped. This is a real pick-up,
   *    and the timestamp is the moment it actually stopped, which is what a
   *    student who missed it wants to know.
   *
   *  · CROSSING — the bus went from before the stop to past it. This exists
   *    because the halt test can only ever see the instants we happen to
   *    sample. A bus with nobody waiting does not slow down at all, and a
   *    10-second GPS gap at 60 km/h covers 167 m — wider than the geofence —
   *    so the bus can be before the stop on one fix and past it on the next
   *    without ever appearing "at" it.
   *
   * Only ever called for NORMAL progress — the bus driving the plan. A jump
   * is decided by jump(), on the evidence of the road driven, because a
   * crossing detector would happily "see" the bus pass every stop it jumped.
   *
   * The crossing time is interpolated between the two fixes rather than taken
   * from the later one, so it stays accurate however coarse the sampling is.
   */
  private detectStopEvents(route: LoadedRoute, prevDist: number, prevAt: number) {
    for (const stop of route.stops) {
      if (this.skipped.has(stop.seq)) continue;
      const gap = Math.abs(this.distAlongM - stop.distAlongM);
      const inside = gap <= stop.geofenceM;
      const existing = this.events.find((e) => e.seq === stop.seq);
      if (existing) {
        // A bus that pulls up just PAST the marker crosses it before it slows,
        // so the crossing fires first and calls it a drive-through. If it then
        // halts in the geofence, that was a real pick-up after all — correct
        // the record rather than leave the flag lying.
        if (!existing.halted && inside && this.speedMps <= ARRIVE_SPEED_MPS) {
          existing.halted = true;
          existing.departedAt = null;
          this.openStop = { seq: stop.seq, arrivedAt: existing.arrivedAt };
        }
        continue;
      }

      if (inside && this.speedMps <= ARRIVE_SPEED_MPS) {
        this.record(stop, this.lastFixAt, true);
        this.openStop = { seq: stop.seq, arrivedAt: this.lastFixAt };
        continue;
      }

      // Did we go past it since the last fix?
      if (prevDist < stop.distAlongM && this.distAlongM >= stop.distAlongM) {
        const span = this.distAlongM - prevDist;
        const f = span > 0 ? (stop.distAlongM - prevDist) / span : 1;
        const at = Math.round(prevAt + (this.lastFixAt - prevAt) * f);
        this.record(stop, at, false);
      }
    }
    if (this.openStop) {
      const stop = route.stops[this.openStop.seq];
      if (stop && this.distAlongM > stop.distAlongM + stop.geofenceM) {
        const ev = this.events.find((e) => e.seq === this.openStop!.seq);
        if (ev) ev.departedAt = this.lastFixAt;
        this.openStop = null;
      }
    }
  }

  /** One place that appends a stop event, so every detector agrees on shape. */
  private record(stop: RouteStop, at: number, halted: boolean) {
    if (this.served(stop.seq)) return;
    this.skipped.delete(stop.seq);
    this.events.push({
      stopId: stop.id,
      seq: stop.seq,
      arrivedAt: at,
      departedAt: halted ? null : at, // it never stopped, so it has already left
      delayS: Math.round((at - this.startedAt) / 1000 - stop.schedOffsetS),
      halted,
    });
    this.scoreSnapshots(stop.id, at);
  }

  /**
   * Record what we predicted, so that when the bus actually arrives we can
   * score ourselves. A tracker that never measures its own error never improves.
   */
  private maybeSnapshot(route: LoadedRoute) {
    if (this.elapsedS - this.lastSnapshotAt < SNAPSHOT_EVERY_S) return;
    // Off the plan the ETA comes from a different model; scoring it as this
    // one would muddy the comparison the snapshots exist for.
    if (!this.onPlan) return;
    this.lastSnapshotAt = this.elapsedS;

    const ahead = this.upcoming(route)
      .filter((s) => s.distAlongM > this.distAlongM + 50).slice(0, 4);
    for (const stop of ahead) {
      const preds: [EtaSnapshot['model'], number | null][] = [
        ['profile', this.etaProfileS(route, stop.distAlongM)],
        ['legacy', this.etaLegacyS(route, stop.distAlongM)],
        ['naive', this.etaNaiveS(stop.distAlongM)],
      ];
      for (const [model, eta] of preds) {
        if (eta == null) continue;
        this.snapshots.push({
          stopId: stop.id, predictedAt: this.lastFixAt, model,
          predictedArrival: this.lastFixAt + eta * 1000, horizonS: Math.round(eta),
        });
      }
    }
    if (this.snapshots.length > 4000) this.snapshots.splice(0, 1000);
  }

  private scoreSnapshots(stopId: string, actualArrival: number) {
    for (const s of this.snapshots) {
      if (s.stopId === stopId && s.actualArrival == null) {
        s.actualArrival = actualArrival;
        s.errorS = Math.round((s.predictedArrival - actualArrival) / 1000);
      }
    }
  }

  // ---- the ETA models ---------------------------------------------------

  /**
   * How slow is this bus running *right now*?
   *
   * Being late is not the same as being slow. A bus can be 10 minutes down
   * because of a jam it cleared half an hour ago, and be moving perfectly
   * normally since. Pace measured over the whole trip cannot tell those apart,
   * so it keeps inflating every remaining ETA long after the road is clear.
   *
   * So walk backwards from the current position only far enough to cover a
   * meaningful stretch of the route, and measure pace over that window.
   *
   * This also behaves correctly while the bus is still stuck: to accumulate
   * MIN_REF_S of reference progress you have to reach back past the jam, so the
   * window swallows the standstill and pace stays high — exactly right. Once
   * moving again the window slides forward and pace recovers on its own.
   *
   * Measured in reference time actually DRIVEN, not reference time at the
   * current position — a skipped spur is reference time the bus never spent.
   */
  private pace(): { value: number; basis: 'recent' | 'trip' } {
    const MIN_REF_S = 300;    // reference progress the window must span
    const MIN_REAL_S = 240;   // and real time, so noise cannot swing it
    const MAX_REAL_S = 2400;  // stop reaching back eventually

    const here = this.refDriven;
    const tripPace = here > 90 ? clamp(this.elapsedS / here, 0.6, 2.0) : 1;

    let chosen: { real: number; ref: number } | null = null;
    for (let i = this.track.length - 1; i >= 0; i--) {
      const real = this.elapsedS - this.track[i].t;
      if (real > MAX_REAL_S) break;
      const ref = here - this.track[i].r;
      if (real >= MIN_REAL_S && ref >= MIN_REF_S) { chosen = { real, ref }; break; }
    }
    if (!chosen) return { value: tripPace, basis: 'trip' };

    const recent = clamp(chosen.real / chosen.ref, 0.6, 2.5);

    // Measured on this route: on an undisturbed run the whole-trip average is
    // the better predictor (12s error against 23s), because it averages away
    // noise the recent window still carries. On a run with a jam the recent
    // window wins by a wide margin, because the trip average keeps punishing
    // the bus for traffic it already cleared.
    //
    // So use the disagreement between them as the signal. When they agree,
    // conditions are steady and the smoother estimate should lead; when they
    // diverge, something has changed and only the recent window knows about it.
    const divergence = Math.abs(recent / tripPace - 1);
    const w = clamp(0.12 + divergence / 0.35, 0.12, 1);
    return {
      value: recent * w + tripPace * (1 - w),
      basis: w > 0.5 ? 'recent' : 'trip',
    };
  }

  paceValue() { return this.pace(); }

  /**
   * v1 model: how long did this route take, at this point, on a reference run —
   * rescaled by how fast this bus is running right now.
   *
   * The reference curve already contains dwell time at every stop and the
   * habitual slow patches, which is precisely what distance/speed cannot know.
   */
  etaProfileS(route: LoadedRoute, targetD: number): number | null {
    if (targetD <= this.distAlongM) return null;
    const here = refTimeAt(route, this.distAlongM);
    const there = refTimeAt(route, targetD);
    return Math.max(0, (there - here) * this.pace().value);
  }

  /**
   * The same model with the old whole-trip pace, kept only so the two can be
   * scored against each other on live data. If it ever wins, this one stays.
   */
  etaLegacyS(route: LoadedRoute, targetD: number): number | null {
    if (targetD <= this.distAlongM) return null;
    const here = refTimeAt(route, this.distAlongM);
    const there = refTimeAt(route, targetD);
    const pace = this.refDriven > 90 ? clamp(this.elapsedS / this.refDriven, 0.65, 1.8) : 1;
    return Math.max(0, (there - here) * pace);
  }

  /** v0 model, and what nearly every college bus tracker ships: d / v. */
  etaNaiveS(targetD: number): number | null {
    if (targetD <= this.distAlongM) return null;
    return (targetD - this.distAlongM) / Math.max(this.rawSpeedMps, NAIVE_FLOOR_MPS);
  }

  /**
   * Off the plan, the profile has nothing to say about the road the bus is on.
   * So: road distance from where it is to the next stop it can still serve, at
   * the speed it has actually been doing; then the profile from that stop on.
   */
  offPlanAhead(route: LoadedRoute): { target: RouteStop; etaS: number; coords: [number, number][] | null } | null {
    if (this.onPlan || !this.pos) return null;
    const target = this.upcoming(route).find((s) => !this.likelySkipped(s));
    if (!target) return null;

    const c = this.aheadCache;
    const fresh = c && c.seq === target.seq && haversine(c.at, this.pos) < 60 &&
      this.lastFixAt - c.t < 20_000;
    if (!fresh) {
      const g = getRoadGraph(this.routeId);
      const r = g ? routeBetween(g, [this.pos.lng, this.pos.lat], [target.lng, target.lat]) : null;
      this.aheadCache = {
        seq: target.seq, at: { ...this.pos }, t: this.lastFixAt,
        distM: r ? r.distM : null, coords: r ? simplify(r.coords, 3) : null,
      };
    }
    const ac = this.aheadCache!;
    const distM = ac.distM ?? haversine(this.pos, target) * 1.35;
    // Real recent speed, floored — a bus waiting at a junction is not going
    // to take forever — and ceilinged, because nor will it average highway
    // speed through villages.
    const v = clamp(this.speedMps, 6, 14);
    return { target, etaS: distM / v, coords: ac.coords };
  }

  delayS(route: LoadedRoute): number {
    return Math.round(this.elapsedS - refTimeAt(route, this.distAlongM));
  }
}

// --------------------------------------------------------------- helpers

/**
 * Direction of travel across the last `baseM` metres of positions, degrees.
 * Null until the bus has moved that far within the window.
 */
function headingAcross(pts: Where[], baseM: number): number | null {
  const end = pts[pts.length - 1];
  for (let i = pts.length - 2; i >= 0; i--) {
    if (haversine(pts[i], end) >= baseM) {
      const kx = 111320 * Math.cos((end.lat * Math.PI) / 180);
      const dx = (end.lng - pts[i].lng) * kx, dy = (end.lat - pts[i].lat) * 110574;
      return ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
    }
  }
  return null;
}

/** Interpolate the reference time-vs-distance curve. */
function refTimeAt(route: LoadedRoute, d: number): number {
  const p = route.profile;
  if (d <= p[0].d) return p[0].t;
  let lo = 0, hi = p.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (p[mid].d <= d) lo = mid; else hi = mid;
  }
  const span = p[hi].d - p[lo].d || 1;
  return p[lo].t + ((d - p[lo].d) / span) * (p[hi].t - p[lo].t);
}

/**
 * How close the bus has to come to a stop to have served it, when the only
 * evidence is where it was rather than progress along the plan.
 *
 * Tighter than the geofence on purpose: a stop on a spur can sit 60 m from
 * the main road, and a bus driving past the junction must not count as having
 * gone up the spur. Surveyed stops sit within a few metres of the road; stops
 * whose position is only estimated get far more room, because "the bus never
 * came within 40 m of our guess" says more about the guess than the bus.
 */
function serveRadius(s: RouteStop): number {
  if (s.estimated) return 150;
  // Found by its name rather than pinned: right village, maybe not the exact
  // spot the bus pulls in, so a pass within a few hundred metres counts.
  if (s.verified === false) return 120;
  return Math.max(40, Math.min(60, s.geofenceM * 0.6));
}

/**
 * How far the road actually driven may pass from a stop and it still not be
 * called skipped after a jump. An unproven pin earns the benefit of the doubt:
 * telling a student their stop was skipped when the bus drove right past the
 * real one is the worst message this app can send.
 */
function skipRadius(s: RouteStop): number {
  if (s.estimated) return 1500;
  if (s.verified === false) return 700;
  return serveRadius(s);
}

/** Nearest approach of a path to a point, with the time it happened. */
function closestOnPath(path: Where[], s: { lat: number; lng: number }): { d: number; t: number } | null {
  if (!path.length) return null;
  const kx = 111320 * Math.cos((s.lat * Math.PI) / 180), ky = 110574;
  let best: { d: number; t: number } | null = null;
  for (let i = 0; i < path.length; i++) {
    const a = path[i];
    const b = path[i + 1] ?? a;
    const ax = (a.lng - s.lng) * kx, ay = (a.lat - s.lat) * ky;
    const bx = (b.lng - s.lng) * kx, by = (b.lat - s.lat) * ky;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : clamp(-(ax * dx + ay * dy) / len2, 0, 1);
    const d = Math.hypot(ax + t * dx, ay + t * dy);
    if (!best || d < best.d) best = { d, t: Math.round(a.t + (b.t - a.t) * t) };
  }
  return best;
}

/** Douglas-Peucker, tolerance in metres. Keeps the payload small and the shape intact. */
export function simplify(pts: [number, number][], tolM: number): [number, number][] {
  if (pts.length < 3) return pts;
  const kx = 111320 * Math.cos((pts[0][1] * Math.PI) / 180), ky = 110574;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [i0, i1] = stack.pop()!;
    const [ax, ay] = pts[i0], [bx, by] = pts[i1];
    const dx = (bx - ax) * kx, dy = (by - ay) * ky;
    const len = Math.hypot(dx, dy);
    let worst = -1, wd = 0;
    for (let i = i0 + 1; i < i1; i++) {
      const px = (pts[i][0] - ax) * kx, py = (pts[i][1] - ay) * ky;
      const d = len === 0 ? Math.hypot(px, py) : Math.abs(px * dy - py * dx) / len;
      if (d > wd) { wd = d; worst = i; }
    }
    if (worst > 0 && wd > tolM) {
      keep[worst] = 1;
      stack.push([i0, worst], [worst, i1]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

// ----------------------------------------------------------------- engine

interface Replay { timer: NodeJS.Timeout; routeId: string; speed: number; idx: number }

class Engine {
  trips = new Map<string, Trip>();     // one live trip per route
  replays = new Map<string, Replay>();

  start(routeId: string, at = Date.now()): Trip {
    this.stopReplay(routeId);
    const trip = new Trip(`${routeId}-${at}`, routeId, at);
    this.trips.set(routeId, trip);
    return trip;
  }

  /**
   * Puts a trip back after the process died.
   *
   * A deploy, a crash, or the free tier idling wipes the engine's memory, and
   * the bus vanishes mid-route with the driver none the wiser. The database
   * kept a heartbeat — where it was, how fast, which way — plus the stop
   * history and the trail so far, so this seeds a Trip from all of that and
   * lets the next GPS fix carry on from there.
   */
  restore(key: string, p: {
    id: string; startedAt: number; distAlongM: number; speedMps: number;
    lat: number; lng: number; bearing: number; lastFixAt: number;
    events?: StopEvent[]; skipped?: number[]; trail?: TrailSeg[];
  }): Trip {
    const route = getRoute(key);
    const trip = new Trip(p.id, key, p.startedAt);
    trip.distAlongM = p.distAlongM;
    trip.speedMps = p.speedMps;
    trip.rawSpeedMps = p.speedMps;
    trip.lastFixAt = p.lastFixAt;
    trip.pos = { lng: p.lng, lat: p.lat };
    trip.heading = p.bearing;
    // Counts as having had a fix, so the view shows the restored position
    // and the next real fix is treated as a continuation, not a first fix.
    trip.pingCount = 1;
    // What was skipped before the restart is not in the heartbeat, so pace
    // starts from plain reference time and recovers as the bus drives.
    trip.refDriven = route ? refTimeAt(route, p.distAlongM) : 0;
    if (p.events) trip.events = p.events;
    if (p.skipped) for (const seq of p.skipped) trip.skipped.set(seq, p.lastFixAt);
    if (p.trail?.length) trip.tracker.restore(p.trail);
    // NOT lastSeenAt: freshness is about how long ago WE heard from the bus,
    // and we have not. Leaving it at zero makes the marker show as stale
    // until a real fix arrives, which is the truth.
    trip.lastSeenAt = 0;
    this.trips.set(key, trip);
    return trip;
  }

  /** Finished trips whose final state has not been written yet. */
  unflushed(): { key: string; trip: Trip }[] {
    return [...this.trips.entries()]
      .filter(([, t]) => t.status === 'finished' && !t.flushed)
      .map(([key, trip]) => ({ key, trip }));
  }

  /** Every live trip, for the server-side ticker. */
  liveTrips(): { key: string; trip: Trip }[] {
    return [...this.trips.entries()]
      .filter(([, t]) => t.status === 'running')
      .map(([key, trip]) => ({ key, trip }));
  }

  end(routeId: string) {
    const t = this.trips.get(routeId);
    if (t) { t.status = 'finished'; t.tracker.close(); }
    this.stopReplay(routeId);
  }

  ingest(routeId: string, pings: Ping[], source: PingSource) {
    const route = getRoute(routeId);
    if (!route) return { accepted: 0, rejected: pings.length };

    const firstT = pings[0]?.t ?? Date.now();
    let trip = this.trips.get(routeId);

    if (!trip) {
      trip = this.start(routeId, firstT);
    } else if (trip.status === 'finished') {
      // A completed run keeps receiving fixes — the phone is still on the bus
      // parked at the campus gate. Those are the tail of the journey that just
      // ended, not a new one, and starting a fresh trip for them would wipe the
      // stop log and the accuracy scores of the run that just finished.
      // Only a real gap means the bus has genuinely set off again.
      const gapS = (firstT - trip.lastFixAt) / 1000;
      if (gapS < 900) return { accepted: 0, rejected: pings.length };
      trip = this.start(routeId, firstT);
    }

    let accepted = 0;
    const sorted = [...pings].sort((a, b) => a.t - b.t);
    for (const p of sorted) {
      if (trip.accept(route, p, source)) accepted++;
      else trip.rejectedCount++;
    }

    if (accepted) void this.persist(trip, sorted, source);
    return { accepted, rejected: sorted.length - accepted };
  }

  /** Append-only log. Fire and forget — a slow disk must not stall ingest. */
  private async persist(trip: Trip, pings: Ping[], source: PingSource) {
    try {
      const line = pings.map((p) => JSON.stringify({ ...p, source })).join('\n') + '\n';
      await appendFile(join(process.cwd(), 'data', 'trips', `${trip.id}.jsonl`), line);
    } catch {
      /* logging must never break tracking */
    }
  }

  // ---- replay ----------------------------------------------------------

  startReplay(routeId: string, points: { t: number; lat: number; lng: number; spd: number; acc: number }[], speed: number) {
    this.stopReplay(routeId);
    const t0 = Date.now();
    const trip = this.start(routeId, t0);
    // Fix timestamps keep real spacing so speeds are right, but they are fed
    // `speed` times faster than real time. Record that so the view can present
    // wall-clock times instead of a device clock running into the future.
    trip.clockOrigin = t0;
    trip.clockScale = speed;

    // Feed one wall-clock second of fixes every tick, `speed` times faster.
    const TICK_MS = 500;
    const state: Replay = { routeId, speed, idx: 0, timer: null as never };
    state.timer = setInterval(() => {
      const advance = (speed * TICK_MS) / 1000;
      const until = state.idx + advance;
      const batch: Ping[] = [];
      while (state.idx < until && state.idx < points.length) {
        const p = points[Math.floor(state.idx)];
        batch.push({
          lat: p.lat, lng: p.lng, spd: p.spd, acc: p.acc,
          // Fix timestamps keep their ORIGINAL spacing. Only delivery is
          // accelerated. Compressing them too would make the engine believe the
          // bus is doing 100 km/h and arriving an hour early.
          t: t0 + p.t * 1000,
        });
        state.idx += 1;
      }
      if (batch.length) this.ingest(routeId, batch, 'replay');
      // Run the trace to its end. Stopping at 'finished' cut off the
      // stationary fixes at the terminus, so the arrival there never fired.
      //
      // Then close the trip. Leaving it open meant the fleet card sat on LIVE
      // with a frozen position while offering to start the demo again — two
      // contradictory things on one card.
      if (state.idx >= points.length) {
        this.stopReplay(routeId);
        this.end(routeId);
      }
    }, TICK_MS);

    this.replays.set(routeId, state);
  }

  stopReplay(routeId: string) {
    const r = this.replays.get(routeId);
    if (r) { clearInterval(r.timer); this.replays.delete(routeId); }
  }

  isReplaying(routeId: string) { return this.replays.has(routeId); }

  // ---- read model ------------------------------------------------------

  /**
   * The settled trail, from point `n` on. The trail only ever grows at the
   * end, so a client that already has `n` points needs only what follows —
   * a few hundred bytes a poll instead of the whole road so far.
   */
  trail(routeId: string, tripId: string | null, n: number): TrailView {
    const trip = this.trips.get(routeId);
    if (!trip || trip.pingCount === 0) return { tripId: null, n: 0, add: [], reset: true };
    const segs = trip.tracker.committed;
    const total = trip.tracker.committedPts;
    const reset = tripId !== trip.id || !(n >= 0) || n > total;
    const from = reset ? 0 : n;
    const add: TrailView['add'] = [];
    let seen = 0;
    segs.forEach((seg, s) => {
      const end = seen + seg.pts.length;
      if (end > from) add.push({ s, kind: seg.kind, pts: seg.pts.slice(Math.max(0, from - seen)) });
      seen = end;
    });
    return { tripId: trip.id, n: total, add, reset };
  }

  /** The live trip object itself, for the ticker that mirrors it to the database. */
  tripFor(routeId: string): Trip | undefined { return this.trips.get(routeId); }

  view(routeId: string): StateView | null {
    const route = getRoute(routeId);
    if (!route) return null;
    const trip = this.trips.get(routeId);
    const now = Date.now();

    const base = {
      now,
      route: {
        id: route.id, code: route.code, name: route.name, short: route.short,
        color: route.color, lengthM: route.lengthM, schedStart: route.schedStart,
      },
    };

    if (!trip || trip.pingCount === 0) {
      return {
        ...base,
        trip: null,
        stops: route.stops.map((s) => ({
          id: s.id, seq: s.seq, name: s.name, lat: s.lat, lng: s.lng,
          distAlongM: s.distAlongM, schedOffsetS: s.schedOffsetS, estimated: s.estimated,
          verified: s.verified, extra: s.extra,
          etaS: null, etaLoS: null, etaHiS: null, etaNaiveS: null,
          passed: false, state: 'upcoming' as StopState, skippedByM: null,
          arrivedAt: null, delayS: null, halted: null,
        })),
        events: [],
        accuracy: [],
      };
    }

    // Engine timestamps are device time. During a replay that clock runs ahead
    // of the wall clock, so an arrival recorded "at 13:40" would be displayed
    // while it is still 13:02. Map every absolute time back before it is shown,
    // and scale durations the same way, so the whole screen agrees with a watch.
    const wall = (ts: number | null) =>
      ts == null ? null
        : trip.clockScale === 1 ? ts
        : Math.round(trip.clockOrigin + (ts - trip.clockOrigin) / trip.clockScale);
    const dur = (s: number | null) =>
      s == null ? null : Math.round(s / trip.clockScale);

    const ageS = (now - trip.lastSeenAt) / 1000;
    const confidence: Confidence =
      ageS < 30 ? 'live' : ageS < 180 ? 'recent' : ageS < 300 ? 'estimated' : 'stale';

    // While the signal is merely late (not dead) keep the marker moving along
    // the plan, and label it as an estimate rather than a fix.
    //
    // DEAD RECKONING IS A BRIDGE, NOT A SUBSTITUTE. This used to coast for
    // four minutes, which at 60 km/h is four kilometres of invented travel,
    // and it stayed non-stale for ten. So a phone that had stopped uploading
    // produced a bus that glided smoothly through villages it was nowhere
    // near, and only then went offline — the exact behaviour that made the
    // app feel untrustworthy. Now: nothing at all while fixes arrive
    // normally, then a short ramp, then a full stop — and only ever along the
    // plan while the bus is ON the plan. Off it there is no road we could
    // honestly extrapolate along, so the marker stays where it was last seen.
    const COAST_FROM_S = 30;   // where the 'live' band ends
    const COAST_S = 45;
    const coastS = trip.onPlan && trip.status === 'running'
      ? clamp(ageS - COAST_FROM_S, 0, COAST_S - COAST_FROM_S) : 0;
    const shownDist = clamp(trip.distAlongM + trip.speedMps * coastS, 0, route.lengthM);
    const pos = coastS > 0 || !trip.pos
      ? atDistance(route.shape, route.cum, shownDist)
      : trip.pos;

    const ahead = trip.status === 'running' && confidence !== 'stale' ? trip.offPlanAhead(route) : null;
    const pace = trip.paceValue();

    // ---- stops -----------------------------------------------------------
    const states = new Map<number, StopState>();
    for (const s of route.stops) {
      const st: StopState =
        trip.events.some((e) => e.seq === s.seq) ? 'served'
        : trip.skipped.has(s.seq) ? 'skipped'
        : trip.likelySkipped(s) ? 'likely-skipped'
        // Behind the bus with nothing recorded happens only after a restart
        // lost the last few seconds of history. Say passed rather than leave
        // a stop the bus is clearly beyond showing as still to come.
        : s.distAlongM < trip.distAlongM - 5 ? 'served'
        : 'upcoming';
      states.set(s.seq, st);
    }

    const etaFor = (s: RouteStop): number | null => {
      if (confidence === 'stale' || states.get(s.seq) !== 'upcoming') return null;
      if (ahead) {
        if (s.seq === ahead.target.seq) return ahead.etaS;
        if (s.seq < ahead.target.seq) return null;
        return ahead.etaS + Math.max(0,
          refTimeAt(route, s.distAlongM) - refTimeAt(route, ahead.target.distAlongM)) * pace.value;
      }
      if (!trip.onPlan) return null;   // off the plan with no road data: say so, do not guess
      return trip.etaProfileS(route, s.distAlongM);
    };

    const stops: StopView[] = route.stops.map((s) => {
      const ev = trip.events.find((e) => e.seq === s.seq);
      const state = states.get(s.seq)!;
      const eta = etaFor(s);
      const naive = eta == null ? null : trip.etaNaiveS(s.distAlongM);
      // Uncertainty widens with the horizon — an honest 10-minute number is a
      // range, not a point. Off the plan it is wider still: that ETA rests on
      // a routed estimate, not on how long this road usually takes.
      const floor = ahead ? 0.18 : 0.09;
      const spread = eta == null ? 0 : clamp(floor + eta * 0.0007, floor, 0.4);
      return {
        id: s.id, seq: s.seq, name: s.name, lat: s.lat, lng: s.lng,
        distAlongM: s.distAlongM, schedOffsetS: s.schedOffsetS, estimated: s.estimated,
        verified: s.verified, extra: s.extra,
        etaS: dur(eta),
        etaLoS: eta == null ? null : dur(eta * (1 - spread)),
        etaHiS: eta == null ? null : dur(eta * (1 + spread)),
        etaNaiveS: dur(naive),
        passed: state === 'served' || state === 'skipped',
        state,
        skippedByM: state === 'skipped' ? trip.skippedByM.get(s.seq) ?? null : null,
        arrivedAt: wall(ev?.arrivedAt ?? null),
        halted: ev ? ev.halted : null,
        delayS: ev?.delayS ?? null,
      };
    });

    const nextStop = route.stops.find((s) => states.get(s.seq) === 'upcoming') ?? null;
    const offRouteS = trip.offPlanSince != null
      ? Math.round((trip.lastFixAt - trip.offPlanSince) / 1000) : null;

    const tripView: TripView = {
      id: trip.id, routeId, status: trip.status, startedAt: wall(trip.startedAt)!,
      distAlongM: Math.round(shownDist),
      speedMps: +trip.speedMps.toFixed(2),
      lat: pos.lat, lng: pos.lng,
      bearing: Math.round(trip.heading ?? bearingAt(route.shape, route.cum, shownDist)),
      source: trip.source, confidence, ageS: Math.round(ageS),
      delayS: trip.delayS(route),
      nextStopSeq: nextStop?.seq ?? null,
      progress: clamp(shownDist / route.lengthM, 0, 1),
      pingCount: trip.pingCount, rejectedCount: trip.rejectedCount,
      pace: +pace.value.toFixed(2),
      paceBasis: pace.basis,
      onRoute: trip.onPlan,
      offRouteS: trip.onPlan ? null : dur(offRouteS),
      matched: trip.onRoad,
      tail: simplify(trip.tracker.tail(), 2),
      trailN: trip.tracker.committedPts,
      aheadVia: ahead?.coords ?? null,
      aheadFromM: ahead ? ahead.target.distAlongM : Math.round(shownDist),
      drivenM: Math.round(trip.drivenM),
    };

    // Self-scoring: mean absolute error of every prediction the bus has since
    // driven past, split by model.
    const accuracy = (['profile', 'legacy', 'naive'] as const).map((model) => {
      const scored = trip.snapshots.filter(
        (s) => s.model === model && s.errorS != null && s.horizonS >= 60 && s.horizonS <= 1200,
      );
      const maeS = scored.length
        ? Math.round(scored.reduce((a, s) => a + Math.abs(s.errorS!), 0) / scored.length)
        : 0;
      return { model, n: scored.length, maeS };
    });

    // Events carry timestamps too, and the admin log reads them.
    const events = trip.events.map((ev) => ({
      ...ev,
      arrivedAt: wall(ev.arrivedAt)!,
      departedAt: wall(ev.departedAt),
    }));

    return { ...base, trip: tripView, stops, events, accuracy };
  }
}

export type { Trip };

// Survive Next.js dev hot-reloads — otherwise every edit silently drops the
// running trip and the demo appears to lose its bus.
const g = globalThis as unknown as { __busEngine?: Engine };
export const engine = g.__busEngine ?? (g.__busEngine = new Engine());
