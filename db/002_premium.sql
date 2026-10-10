-- Adds: persisted live trips, the return journey, push notifications,
-- admin alerts, and "I'm at the stop". Safe to run more than once.

-- ---------------------------------------------------------------- trips
-- A trip now has a DIRECTION. The morning run goes village → campus; the
-- afternoon run is the same road travelled the other way, and a student
-- waiting at 16:50 is asking about a completely different bus than at 07:20.
ALTER TABLE trips ADD COLUMN IF NOT EXISTS direction text NOT NULL DEFAULT 'outbound';

-- The live position, written every few seconds.
--
-- Live state lives in memory because a position is worthless thirty seconds
-- later. But "in memory" also means a deploy, a crash, or the free tier idling
-- makes the bus vanish mid-route with the driver none the wiser. This is a
-- heartbeat, not a history: four columns, overwritten in place, so a restarted
-- server can pick the trip back up exactly where it was.
ALTER TABLE trips ADD COLUMN IF NOT EXISTS last_lat        double precision;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS last_lng        double precision;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS last_dist_m     double precision;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS last_speed_mps  double precision;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS last_bearing    double precision;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS last_fix_at     timestamptz;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS engine_id       text;

-- One running trip per route AND direction — a bus can't be going both ways.
DROP INDEX IF EXISTS trips_one_running_per_route;
CREATE UNIQUE INDEX IF NOT EXISTS trips_one_running_per_route_dir
  ON trips(route_id, direction) WHERE status = 'running';

-- ---------------------------------------------------------------- routes
-- When the bus leaves the college in the afternoon. Until now the drop times
-- on every screen were arithmetic on a hard-coded 16:45 guess.
ALTER TABLE routes ADD COLUMN IF NOT EXISTS return_start text NOT NULL DEFAULT '16:45';

ALTER TABLE stop_events ADD COLUMN IF NOT EXISTS direction text NOT NULL DEFAULT 'outbound';

-- -------------------------------------------------------- push notifications
-- One row per device, not per student: a student with a phone and a laptop
-- should be told on both, and revoking one must not silence the other.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint    text PRIMARY KEY,
  roll_no     text NOT NULL REFERENCES students(roll_no) ON DELETE CASCADE,
  p256dh      text NOT NULL,
  auth        text NOT NULL,
  -- minutes of warning the student asked for, mirroring the walk-time slider
  lead_min    integer NOT NULL DEFAULT 5,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_sent_at timestamptz,
  failures    integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS push_subs_roll_idx ON push_subscriptions(roll_no);

-- What we have already said, so nobody is told twice that the bus is coming.
-- The unique key IS the deduplication: the sender inserts first and only
-- sends if the insert won, which is race-free without a lock.
CREATE TABLE IF NOT EXISTS notifications_sent (
  trip_id   bigint NOT NULL,
  roll_no   text NOT NULL,
  kind      text NOT NULL,          -- 'approaching' | 'started' | 'arrived'
  sent_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (trip_id, roll_no, kind)
);

-- ---------------------------------------------------------------- alerts
-- Raised by the watcher, cleared when the condition goes away. The office
-- sees a short list of what is wrong rather than a scrolling log.
CREATE TABLE IF NOT EXISTS alerts (
  id         bigserial PRIMARY KEY,
  route_id   text NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  kind       text NOT NULL,         -- 'not_started' | 'late' | 'signal_lost'
  severity   text NOT NULL DEFAULT 'warn',
  message    text NOT NULL,
  raised_at  timestamptz NOT NULL DEFAULT now(),
  cleared_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS alerts_one_open_per_kind
  ON alerts(route_id, kind) WHERE cleared_at IS NULL;

-- ------------------------------------------------------- I'm at the stop
-- A student taps once to say they are standing there. The driver sees a count
-- so he does not roll past an empty-looking stop that has three people on it.
-- Short-lived on purpose: it is a statement about right now.
CREATE TABLE IF NOT EXISTS waiting (
  roll_no   text PRIMARY KEY REFERENCES students(roll_no) ON DELETE CASCADE,
  route_id  text NOT NULL,
  stop_id   text NOT NULL,
  at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS waiting_route_idx ON waiting(route_id, at DESC);
