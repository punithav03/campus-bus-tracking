/**
 * The live position + ETA engine.
 *
 * Every GPS fix — from a phone on the bus, a rider broadcasting, or replay of a
 * recorded trip — enters through `ingest()` and takes the identical path:
 *
 *     sanity filter -> project onto route -> alpha-beta smooth
 *       -> stop geofences -> ETA (naive + profile) -> snapshot for scoring
 *
 * Because seed data, replay and real phones all share this path, anything that
 * works in the demo works on a real bus.
 */

import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atDistance, bearingAt, clamp, projectOnto } from './geo';
import { getRoute, type LoadedRoute } from './network';
import type {
  Confidence, EtaSnapshot, Ping, PingSource, StateView, StopEvent, StopView, TripView,
} from './types';

// ------------------------------------------------------------------ tuning

const MAX_ACCURACY_M = 75;    // bin fixes worse than this outright
const MAX_OFFSET_M = 250;     // more than this from the road = not on the route
const MAX_BACKWARD_M = 150;   // buses do not reverse 150 m
const MAX_SPEED_MPS = 30;     // 108 km/h — impossible for a college bus

// Projection window, asymmetric on purpose — see projectOnto() in geo.ts.
// Routes that double back will silently corrupt a trip without this.
const PROJECT_BACK_M = 80;
const PROJECT_FWD_MIN_M = 150;

const ALPHA = 0.45;           // position correction per residual
const BETA = 0.09;            // velocity correction per residual

const ARRIVE_SPEED_MPS = 1.6;
const SNAPSHOT_EVERY_S = 20;

// Naive ETA divides by current speed. Below this floor the number explodes to
// infinity, so every real implementation clamps — and the clamp is exactly why
// naive ETAs lurch every time a bus slows for a junction.
const NAIVE_FLOOR_MPS = 2.5;

// ------------------------------------------------------------------- trip

class Trip {
  id: string;
  routeId: string;
  startedAt: number;              // epoch ms, from the first accepted fix
  status: 'running' | 'finished' = 'running';

  distAlongM = 0;
  speedMps = 0;
  rawSpeedMps = 0;

  lastFixAt = 0;                  // device clock of the last accepted fix
  lastSeenAt = 0;                 // server clock — drives the freshness badge
  source: PingSource = 'device';

  pingCount = 0;
  rejectedCount = 0;

  events: StopEvent[] = [];
  private openStop: { seq: number; arrivedAt: number } | null = null;
  snapshots: EtaSnapshot[] = [];
  private lastSnapshotAt = -1e9;

  /** Smoothed (elapsedS, distAlongM) samples for the admin progress chart. */
  track: { t: number; d: number }[] = [];

  constructor(id: string, routeId: string, startedAt: number) {
    this.id = id;
    this.routeId = routeId;
    this.startedAt = startedAt;
  }

  get elapsedS() {
    return Math.max(0, (this.lastFixAt - this.startedAt) / 1000);
  }

  accept(route: LoadedRoute, p: Ping, source: PingSource): boolean {
    // ---- sanity filters -------------------------------------------------
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) return false;
    if (p.acc != null && p.acc > MAX_ACCURACY_M) return false;
    if (p.spd != null && p.spd > MAX_SPEED_MPS) return false;

    const first = this.pingCount === 0;
    const dtS = first ? 1 : Math.max(0.25, (p.t - this.lastFixAt) / 1000);
    if (!first && p.t <= this.lastFixAt) return false; // out of order / duplicate

    // ---- project onto the route ----------------------------------------
    const proj = projectOnto(
      route.shape, route.cum, p,
      first ? null : this.distAlongM,
      PROJECT_BACK_M,
      Math.max(PROJECT_FWD_MIN_M, MAX_SPEED_MPS * dtS * 1.6),
    );
    if (proj.offsetM > MAX_OFFSET_M) return false;
    if (!first && proj.distAlong < this.distAlongM - MAX_BACKWARD_M) return false;

    // ---- alpha-beta smoothing on (distance, speed) ----------------------
    if (first) {
      this.distAlongM = proj.distAlong;
      this.speedMps = p.spd ?? 0;
      this.startedAt = p.t;
    } else {
      const predicted = this.distAlongM + this.speedMps * dtS;
      const residual = proj.distAlong - predicted;
      this.distAlongM = predicted + ALPHA * residual;
      this.speedMps = clamp(this.speedMps + (BETA / dtS) * residual, 0, MAX_SPEED_MPS);
    }
    this.distAlongM = clamp(this.distAlongM, 0, route.lengthM);
    this.rawSpeedMps = p.spd ?? this.speedMps;
    this.lastFixAt = p.t;
    this.lastSeenAt = Date.now();
    this.source = source;
    this.pingCount++;

    this.detectStopEvents(route);
    this.maybeSnapshot(route);

    const el = this.elapsedS;
    if (!this.track.length || el - this.track[this.track.length - 1].t >= 10) {
      this.track.push({ t: Math.round(el), d: Math.round(this.distAlongM) });
    }
    if (this.distAlongM >= route.lengthM - 30) this.status = 'finished';
    return true;
  }

  /** Geofence + near-zero speed = arrival. Leaving the circle = departure. */
  private detectStopEvents(route: LoadedRoute) {
    for (const stop of route.stops) {
      const gap = Math.abs(this.distAlongM - stop.distAlongM);
      const inside = gap <= stop.geofenceM;
      const already = this.events.some((e) => e.seq === stop.seq);

      if (inside && !already && this.speedMps <= ARRIVE_SPEED_MPS) {
        this.events.push({
          stopId: stop.id,
          seq: stop.seq,
          arrivedAt: this.lastFixAt,
          departedAt: null,
          delayS: Math.round(this.elapsedS - stop.schedOffsetS),
        });
        this.openStop = { seq: stop.seq, arrivedAt: this.lastFixAt };
        this.scoreSnapshots(stop.id, this.lastFixAt);
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

  /**
   * Record what we predicted, so that when the bus actually arrives we can
   * score ourselves. A tracker that never measures its own error never improves.
   */
  private maybeSnapshot(route: LoadedRoute) {
    if (this.elapsedS - this.lastSnapshotAt < SNAPSHOT_EVERY_S) return;
    this.lastSnapshotAt = this.elapsedS;

    const ahead = route.stops.filter((s) => s.distAlongM > this.distAlongM + 50).slice(0, 4);
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

  // ---- the two ETA models ----------------------------------------------

  /** Interpolate the reference time-vs-distance curve. */
  private refTimeAt(route: LoadedRoute, d: number): number {
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
   */
  private pace(route: LoadedRoute): { value: number; basis: 'recent' | 'trip' } {
    const MIN_REF_S = 300;    // reference progress the window must span
    const MIN_REAL_S = 240;   // and real time, so noise cannot swing it
    const MAX_REAL_S = 2400;  // stop reaching back eventually

    const here = this.refTimeAt(route, this.distAlongM);
    const tripPace = here > 90 ? clamp(this.elapsedS / here, 0.6, 2.0) : 1;

    let chosen: { real: number; ref: number } | null = null;
    for (let i = this.track.length - 1; i >= 0; i--) {
      const real = this.elapsedS - this.track[i].t;
      if (real > MAX_REAL_S) break;
      const ref = here - this.refTimeAt(route, this.track[i].d);
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

  paceValue(route: LoadedRoute) { return this.pace(route); }

  /**
   * v1 model: how long did this route take, at this point, on a reference run —
   * rescaled by how fast this bus is running right now.
   *
   * The reference curve already contains dwell time at every stop and the
   * habitual slow patches, which is precisely what distance/speed cannot know.
   */
  etaProfileS(route: LoadedRoute, targetD: number): number | null {
    if (targetD <= this.distAlongM) return null;
    const here = this.refTimeAt(route, this.distAlongM);
    const there = this.refTimeAt(route, targetD);
    return Math.max(0, (there - here) * this.pace(route).value);
  }

  /**
   * The same model with the old whole-trip pace, kept only so the two can be
   * scored against each other on live data. If it ever wins, this one stays.
   */
  etaLegacyS(route: LoadedRoute, targetD: number): number | null {
    if (targetD <= this.distAlongM) return null;
    const here = this.refTimeAt(route, this.distAlongM);
    const there = this.refTimeAt(route, targetD);
    const pace = here > 90 ? clamp(this.elapsedS / here, 0.65, 1.8) : 1;
    return Math.max(0, (there - here) * pace);
  }

  /** v0 model, and what nearly every college bus tracker ships: d / v. */
  etaNaiveS(targetD: number): number | null {
    if (targetD <= this.distAlongM) return null;
    return (targetD - this.distAlongM) / Math.max(this.rawSpeedMps, NAIVE_FLOOR_MPS);
  }

  delayS(route: LoadedRoute): number {
    return Math.round(this.elapsedS - this.refTimeAt(route, this.distAlongM));
  }
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

  end(routeId: string) {
    const t = this.trips.get(routeId);
    if (t) t.status = 'finished';
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
    this.start(routeId, t0);

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
      const trip = this.trips.get(routeId);
      if (state.idx >= points.length || trip?.status === 'finished') {
        this.stopReplay(routeId);
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
          etaS: null, etaLoS: null, etaHiS: null, etaNaiveS: null,
          passed: false, arrivedAt: null, delayS: null,
        })),
        events: [],
        accuracy: [],
      };
    }

    const ageS = (now - trip.lastSeenAt) / 1000;
    const confidence: Confidence =
      ageS < 30 ? 'live' : ageS < 180 ? 'recent' : ageS < 600 ? 'estimated' : 'stale';

    // While the signal is merely late (not dead) keep the marker moving along
    // the reference curve, and label it as an estimate rather than a fix.
    let shownDist = trip.distAlongM;
    if (confidence === 'estimated') {
      shownDist = clamp(trip.distAlongM + trip.speedMps * Math.min(ageS, 240), 0, route.lengthM);
    }
    const pos = atDistance(route.shape, route.cum, shownDist);

    const tripView: TripView = {
      id: trip.id, routeId, status: trip.status, startedAt: trip.startedAt,
      distAlongM: Math.round(shownDist),
      speedMps: +trip.speedMps.toFixed(2),
      lat: pos.lat, lng: pos.lng,
      bearing: Math.round(bearingAt(route.shape, route.cum, shownDist)),
      source: trip.source, confidence, ageS: Math.round(ageS),
      delayS: trip.delayS(route),
      nextStopSeq: route.stops.find((s) => s.distAlongM > shownDist)?.seq ?? null,
      progress: clamp(shownDist / route.lengthM, 0, 1),
      pingCount: trip.pingCount, rejectedCount: trip.rejectedCount,
      pace: +trip.paceValue(route).value.toFixed(2),
      paceBasis: trip.paceValue(route).basis,
    };

    const stops: StopView[] = route.stops.map((s) => {
      const ev = trip.events.find((e) => e.seq === s.seq);
      const eta = confidence === 'stale' ? null : trip.etaProfileS(route, s.distAlongM);
      const naive = confidence === 'stale' ? null : trip.etaNaiveS(s.distAlongM);
      // Uncertainty widens with the horizon — an honest 10-minute number is a
      // range, not a point.
      const spread = eta == null ? 0 : clamp(0.09 + eta * 0.0007, 0.09, 0.34);
      return {
        id: s.id, seq: s.seq, name: s.name, lat: s.lat, lng: s.lng,
        distAlongM: s.distAlongM, schedOffsetS: s.schedOffsetS, estimated: s.estimated,
        etaS: eta == null ? null : Math.round(eta),
        etaLoS: eta == null ? null : Math.round(eta * (1 - spread)),
        etaHiS: eta == null ? null : Math.round(eta * (1 + spread)),
        etaNaiveS: naive == null ? null : Math.round(naive),
        passed: s.distAlongM <= shownDist || !!ev,
        arrivedAt: ev?.arrivedAt ?? null,
        delayS: ev?.delayS ?? null,
      };
    });

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

    return { ...base, trip: tripView, stops, events: trip.events, accuracy };
  }
}

// Survive Next.js dev hot-reloads — otherwise every edit silently drops the
// running trip and the demo appears to lose its bus.
const g = globalThis as unknown as { __busEngine?: Engine };
export const engine = g.__busEngine ?? (g.__busEngine = new Engine());
