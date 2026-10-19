export interface Stop {
  id: string;
  seq: number;
  name: string;
  lat: number;
  lng: number;
  distAlongM: number;
  geofenceM: number;
  schedOffsetS: number;
  /** Position is interpolated, not surveyed — shown as ~ in the UI. */
  estimated?: boolean;
  /**
   * Pinned by hand, seen on a recorded ride, or a mapped bus stop. A village
   * found by its name is probably right but unproven: the engine gives it more
   * room before calling it skipped, and nobody is pushed about it.
   */
  verified?: boolean;
  /** A student pickup point the bus passes that is not on the office's sheet. */
  extra?: boolean;
  /** The office's time for this stop, 'HH:MM'. */
  time?: string;
}

export interface BusInfo {
  number: string | null;
  driver: string | null;
  driverPhone: string | null;
}

export interface RouteData {
  id: string;
  code: string;
  name: string;
  short: string;
  color: string;
  schedStart: string;
  lengthM: number;
  durationS: number;
  shape: [number, number][];
  stops: Stop[];
  /** Reference time-vs-distance curve — the v1 ETA model. */
  profile: { d: number; t: number }[];
  source: string;
  /** The vehicle and driver, from the office's sheet. */
  bus?: BusInfo;
}

export interface Campus {
  name: string;
  fullName: string;
  address: string;
  lat: number;
  lng: number;
  catchmentKm: number;
}

export interface RouteSummary {
  id: string; code: string; name: string; short: string; color: string;
  schedStart: string; lengthM: number; durationS: number; stopCount: number;
  firstStop: string; lastStop: string;
  busNumber?: string | null; driver?: string | null;
}

export interface Network {
  campus: Campus;
  routes: RouteSummary[];
}

/** How much to trust the dot on the map right now. */
export type Confidence = 'live' | 'recent' | 'estimated' | 'stale';

export type PingSource = 'device' | 'driver' | 'rider' | 'replay';

export interface Ping {
  lat: number;
  lng: number;
  /** m/s as reported by the GPS chip, if it gave one. */
  spd?: number | null;
  acc?: number | null;
  heading?: number | null;
  /** epoch ms on the device */
  t: number;
}

export interface StopEvent {
  stopId: string;
  seq: number;
  arrivedAt: number;
  departedAt: number | null;
  /** Actual minus scheduled, in seconds. Negative = early. */
  delayS: number;
  /**
   * True if the bus actually halted here; false if it drove straight past.
   * Worth keeping apart: "picked up at 08:12" and "went by at 08:12" are
   * different facts to a student who is running late.
   */
  halted: boolean;
}

export interface EtaSnapshot {
  stopId: string;
  predictedAt: number;
  predictedArrival: number;
  horizonS: number;
  model: 'naive' | 'profile' | 'legacy';
  actualArrival?: number;
  errorS?: number;
}

/**
 * What happened at a stop, as OBSERVED — never inferred from distance alone.
 *
 *   served          the bus halted there, or was seen driving through it
 *   skipped         the bus went on past without ever coming near it — a
 *                   village with nobody waiting, a diversion around it
 *   likely-skipped  off its route and getting further from this stop; not
 *                   yet certain, so it is said as a likelihood
 *   upcoming        not reached yet
 */
export type StopState = 'served' | 'skipped' | 'likely-skipped' | 'upcoming';

export interface StopView {
  id: string;
  seq: number;
  name: string;
  lat: number;
  lng: number;
  distAlongM: number;
  schedOffsetS: number;
  /** Seconds until the bus reaches this stop; null once passed or unknown. */
  etaS: number | null;
  etaLoS: number | null;
  etaHiS: number | null;
  etaNaiveS: number | null;
  /** Behind the bus: served or skipped. Kept for screens that only need yes/no. */
  passed: boolean;
  state: StopState;
  /** Skipped stops: the closest the bus came, metres, when known. */
  skippedByM?: number | null;
  estimated?: boolean;
  verified?: boolean;
  extra?: boolean;
  arrivedAt: number | null;
  /** Did the bus stop here, or only go past? Null until it has. */
  halted: boolean | null;
  delayS: number | null;
}

export interface TripView {
  id: string;
  routeId: string;
  status: 'running' | 'finished';
  startedAt: number;
  /**
   * Progress along the PLANNED route, in metres. Drives ETAs and the
   * timetable comparison. It is not where the bus is drawn — lat/lng is.
   */
  distAlongM: number;
  speedMps: number;
  lat: number;
  lng: number;
  bearing: number;
  source: PingSource;
  confidence: Confidence;
  ageS: number;
  /** Positive = running late. */
  delayS: number;
  nextStopSeq: number | null;
  progress: number;
  pingCount: number;
  rejectedCount: number;
  /** How slow the bus is running right now. 1.0 = exactly on the reference pace. */
  pace: number;
  paceBasis: 'recent' | 'trip';
  /** On its planned route right now. False while it is somewhere the plan does not go. */
  onRoute: boolean;
  /** Seconds since it left the planned route, while it is off it. */
  offRouteS: number | null;
  /** Position matched to a known road (true) or the raw GPS fix (false). */
  matched: boolean;
  /**
   * The newest stretch of road driven, ending at the bus — still open to
   * revision by the matcher. Drawn as the end of the trail.
   */
  tail: [number, number][];
  /** Points in the settled trail, so a client can fetch only what is new. */
  trailN: number;
  /**
   * Off its route: the road from the bus to where it can rejoin, as routed
   * now. Null when it is on its route.
   */
  aheadVia: [number, number][] | null;
  /** Where along the planned route the line ahead continues from. */
  aheadFromM: number;
  /** Metres actually driven this run, along the road — not progress along the plan. */
  drivenM: number;
}

/** One stretch of the trail. 'road' was matched to a known road; 'gps' is raw fixes joined up. */
export interface TrailPiece { s: number; kind: 'road' | 'gps'; pts: [number, number][] }

export interface TrailView {
  tripId: string | null;
  /** Total settled points; pass back as `n` next time. */
  n: number;
  /** Settled points after the caller's `n`, grouped by segment index `s`. */
  add: TrailPiece[];
  /** True when the caller's copy was stale and this is the whole trail. */
  reset: boolean;
}

export interface StateView {
  now: number;
  route: {
    id: string; code: string; name: string; short: string;
    color: string; lengthM: number; schedStart: string;
  };
  trip: TripView | null;
  stops: StopView[];
  events: StopEvent[];
  accuracy: { model: 'naive' | 'profile' | 'legacy'; n: number; maeS: number }[];
}
