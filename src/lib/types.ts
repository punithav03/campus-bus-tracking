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
  passed: boolean;
  estimated?: boolean;
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
  /** Smoothed position along the route, in metres. */
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
