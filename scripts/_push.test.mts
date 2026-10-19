/**
 * The live notification card: what it says, and when it buzzes.
 *
 *   node --experimental-strip-types scripts/_push.test.mts
 *
 * Pure logic (src/lib/push-plan.ts), no server needed.
 */
import { cardFor, clockIST, type Alert } from '../src/lib/push-plan.ts';

let pass = 0; let fail = 0;
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name} ${extra}`); }
};

type S = Record<string, unknown>;
const stop = (seq: number, name: string, d: number, extra: S = {}) => ({
  id: `r-${seq}`, seq, name, lat: 0, lng: 0, distAlongM: d, schedOffsetS: 0,
  etaS: null, etaLoS: null, etaHiS: null, etaNaiveS: null, passed: false, state: 'upcoming',
  arrivedAt: null, halted: null, delayS: null, verified: true, estimated: false, ...extra,
});
const view = (tripD: number, stops: S[], trip: S = {}) => ({
  now: 0,
  route: { id: 'r', code: '7', name: 'Tirupati — Campus', short: 'Tirupati Bus', color: '#3b82f6', lengthM: 50000, schedStart: '07:45' },
  trip: { id: '1', routeId: 'r', status: 'running', startedAt: 0, distAlongM: tripD, speedMps: 10, lat: 0, lng: 0,
    bearing: 0, source: 'device', confidence: 'live', ageS: 2, delayS: 0, nextStopSeq: 1, progress: tripD / 50000,
    pingCount: 10, rejectedCount: 0, pace: 1, paceBasis: 'trip', onRoute: true, offRouteS: null, matched: true,
    tail: [], trailN: 0, aheadVia: null, aheadFromM: 0, drivenM: tripD, ...trip },
  stops, events: [], accuracy: [],
}) as never;
const none = new Set<Alert>();
const NOW = Date.UTC(2026, 9, 20, 2, 30);  // 08:00 IST

console.log('\n── TIME ──');
ok('clock is Indian time whatever the server zone', clockIST(NOW) === '08:00', clockIST(NOW));

console.log('\n── COMING TO YOU ──');
{
  const stops = [stop(0, 'Town Club', 0, { state: 'served', passed: true }), stop(1, 'Leela Mahal', 10000, { etaS: 600 }),
    stop(2, 'Srinivasam', 20000, { etaS: 1500 }), stop(3, 'SVPCET', 50000, { etaS: 4000 })];
  const c = cardFor({ view: view(3000, stops), stopId: 'r-2', leadMin: 8, sent: none, now: NOW })!;
  ok('early in the run it says the bus has started', c.alert === 'started', String(c.alert));
  ok('the title counts down to your stop', c.title.includes('25 min to Srinivasam'), c.title);
  ok('the body says stops away and the arrival time', c.body.includes('2 stops away') && c.body.includes('arrives 08:25'), c.body);
  ok('it offers "I\'m at the stop"', c.canWait);
  ok('it carries the route picture', (c.image ?? '').startsWith('/api/push/card?'));

  const mid = cardFor({ view: view(9000, stops, { progress: 0.4 }), stopId: 'r-2', leadMin: 8, sent: new Set<Alert>(['started']), now: NOW })!;
  ok('later, the card updates quietly', mid.alert === null && mid.phase === 'live');

  const s2 = stops.map((s) => (s.id === 'r-2' ? { ...s, etaS: 420 } : s));
  const lv = cardFor({ view: view(15000, s2, { progress: 0.5 }), stopId: 'r-2', leadMin: 8, sent: new Set<Alert>(['started']), now: NOW })!;
  ok('within your warning time it buzzes "leave now"', lv.alert === 'leave' && lv.title.startsWith('Leave now'), lv.title);
  const again = cardFor({ view: view(15000, s2, { progress: 0.5 }), stopId: 'r-2', leadMin: 8, sent: new Set<Alert>(['started', 'leave']), now: NOW })!;
  ok('never twice', again.alert === null);

  const s3 = stops.map((s) => (s.id === 'r-1' ? { ...s, state: 'served', passed: true } : s.id === 'r-2' ? { ...s, etaS: 120 } : s));
  const ar = cardFor({ view: view(18500, s3, { progress: 0.6 }), stopId: 'r-2', leadMin: 8, sent: new Set<Alert>(['started', 'leave']), now: NOW })!;
  ok('next stop and under 3 min: "arriving"', ar.alert === 'arriving' && ar.body.startsWith('Next stop is yours'), `${ar.alert} ${ar.body}`);
}

console.log('\n── AT AND AFTER YOUR STOP ──');
{
  const at = [stop(0, 'Town Club', 0, { state: 'served', passed: true }),
    stop(1, 'Srinivasam', 20000, { state: 'served', passed: true, halted: true, arrivedAt: NOW }), stop(2, 'SVPCET', 50000)];
  const c = cardFor({ view: view(20040, at, { speedMps: 0 }), stopId: 'r-1', leadMin: 8, sent: new Set<Alert>(['arriving']), now: NOW })!;
  ok('standing at your stop: "is at Srinivasam", buzzes once', c.alert === 'atstop' && c.title.includes('is at Srinivasam'), c.title);
  const gone = cardFor({ view: view(23000, at), stopId: 'r-1', leadMin: 8, sent: new Set<Alert>(['arriving', 'atstop']), now: NOW })!;
  ok('then a quiet closing card: "left Srinivasam"', gone.alert === null && gone.phase === 'done' && gone.title.includes('left Srinivasam'));
  ok('it says picked up, at what time', gone.body.startsWith('Picked up at 08:00'), gone.body);

  const unsure = at.map((s) => (s.id === 'r-1' ? { ...s, verified: false } : s));
  const u = cardFor({ view: view(23000, unsure), stopId: 'r-1', leadMin: 8, sent: none, now: NOW })!;
  ok('an unproven stop never claims a pick-up', u.body.startsWith('Passed at'), u.body);
}

console.log('\n── SKIPPED ──');
{
  const sk = (extra: S) => [stop(0, 'A', 0, { state: 'served', passed: true }), stop(1, 'Nindra', 10000, { state: 'skipped', passed: true, ...extra }), stop(2, 'SVPCET', 50000)];
  const c = cardFor({ view: view(20000, sk({ skippedByM: 1900 })), stopId: 'r-1', leadMin: 8, sent: none, now: NOW });
  ok('a certain skip is announced', c?.alert === 'skipped' && c.title.includes('did not come to Nindra'));
  ok('a near miss is not', cardFor({ view: view(20000, sk({ skippedByM: 200 })), stopId: 'r-1', leadMin: 8, sent: none, now: NOW }) === null);
  ok('an unproven pin is not', cardFor({ view: view(20000, sk({ skippedByM: 1900, verified: false })), stopId: 'r-1', leadMin: 8, sent: none, now: NOW }) === null);
  ok('an approximate pin is not', cardFor({ view: view(20000, sk({ skippedByM: 1900, estimated: true })), stopId: 'r-1', leadMin: 8, sent: none, now: NOW }) === null);
}

console.log('\n── AT THE COLLEGE ──');
{
  const done = [stop(0, 'A', 0, { state: 'served', passed: true }), stop(1, 'SVPCET', 50000, { state: 'served', passed: true, arrivedAt: NOW + 5 * 60000, delayS: 360 })];
  const c = cardFor({ view: view(50000, done, { status: 'finished' }), stopId: 'r-0', leadMin: 8, sent: none, now: NOW })!;
  ok('the finished run says when it reached the college', c.alert === 'arrived' && c.body.startsWith('Arrived at 08:05') && c.body.includes('6 min late'), c.body);
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
