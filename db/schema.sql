-- SVPCET Bus — database schema
--
-- What lives here and what does not:
--
--   HERE      people, and the history of what the buses actually did.
--             These change, they must survive a restart, and losing them
--             would mean a thousand students re-registering.
--
--   NOT HERE  route geometry. A 1,310-point road line is static reference
--             data; it lives in data/routes/*.json, versioned with the code,
--             the same split transit systems make between a static GTFS feed
--             and a realtime one. It also keeps the engine untouched.
--
--   NOT HERE  live bus positions. A position is worthless thirty seconds
--             later; writing every GPS fix would be millions of rows a year
--             that nobody ever reads. They stay in memory.
--
-- Safe to run more than once.

CREATE TABLE IF NOT EXISTS routes (
  id           text PRIMARY KEY,              -- 'route-1'
  code         text NOT NULL,
  name         text NOT NULL,
  color        text NOT NULL DEFAULT '#38bdf8',
  sched_start  text,                          -- '07:20'
  length_m     integer,
  duration_s   integer,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Mirrors data/routes/*.json so students, boarding points and arrival history
-- can reference a stop by a stable key. Positions here are what the UI shows;
-- a GPS-logger ride updates them in place.
CREATE TABLE IF NOT EXISTS stops (
  id           text PRIMARY KEY,              -- 'route-2-tiruchanoor'
  route_id     text NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  seq          integer NOT NULL,
  name         text NOT NULL,
  lat          double precision NOT NULL,
  lng          double precision NOT NULL,
  dist_along_m integer NOT NULL,
  sched_offset_s integer NOT NULL DEFAULT 0,
  -- true while the pin is a guess rather than a survey
  estimated    boolean NOT NULL DEFAULT false,
  UNIQUE (route_id, seq)
);

CREATE TABLE IF NOT EXISTS drivers (
  id            text PRIMARY KEY,             -- the mobile number; what he types
  name          text NOT NULL,
  phone         text NOT NULL,
  password_hash text NOT NULL,
  route_id      text REFERENCES routes(id) ON DELETE SET NULL,
  active        boolean NOT NULL DEFAULT true,
  must_change_password boolean NOT NULL DEFAULT false,
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admins (
  id            text PRIMARY KEY,
  name          text NOT NULL,
  password_hash text NOT NULL,
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- No self-registration. Every row is created by an admin from the college's
-- own list, which is what makes route_id trustworthy enough to authorise on.
CREATE TABLE IF NOT EXISTS students (
  roll_no       text PRIMARY KEY,
  name          text NOT NULL,
  password_hash text NOT NULL,
  route_id      text REFERENCES routes(id) ON DELETE SET NULL,
  stop_id       text REFERENCES stops(id) ON DELETE SET NULL,
  must_change_password boolean NOT NULL DEFAULT true,
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS students_route_idx ON students(route_id);

CREATE TABLE IF NOT EXISTS trips (
  id          bigserial PRIMARY KEY,
  route_id    text NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  driver_id   text REFERENCES drivers(id) ON DELETE SET NULL,
  started_at  timestamptz NOT NULL DEFAULT now(),
  ended_at    timestamptz,
  -- 'running' | 'finished' | 'abandoned'
  status      text NOT NULL DEFAULT 'running',
  fixes       integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS trips_route_started_idx ON trips(route_id, started_at DESC);
-- One running trip per route. Two phones broadcasting the same bus would make
-- the marker jump between them, so the database refuses it outright.
CREATE UNIQUE INDEX IF NOT EXISTS trips_one_running_per_route
  ON trips(route_id) WHERE status = 'running';

-- The useful history: when the bus actually reached each stop. Small, bounded,
-- and it is what turns the timetable into a measured ETA model over time.
CREATE TABLE IF NOT EXISTS stop_events (
  id         bigserial PRIMARY KEY,
  trip_id    bigint NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  stop_id    text NOT NULL,
  route_id   text NOT NULL,
  reached_at timestamptz NOT NULL,
  -- + late, - early, against the timetable
  delay_s    integer,
  UNIQUE (trip_id, stop_id)
);
CREATE INDEX IF NOT EXISTS stop_events_route_idx ON stop_events(route_id, reached_at DESC);

-- Slows down password guessing without needing Redis.
CREATE TABLE IF NOT EXISTS login_attempts (
  id         bigserial PRIMARY KEY,
  user_id    text NOT NULL,
  ok         boolean NOT NULL,
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS login_attempts_user_idx ON login_attempts(user_id, at DESC);
