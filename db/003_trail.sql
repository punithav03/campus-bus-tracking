-- Plan B: draw the road the bus actually drove.
--
-- Additive only. Code from before this migration keeps working against it:
-- the new column has a default and the new table is only read by new code.

-- A skipped stop is a fact worth keeping — "Nindra skipped 14 of 20 runs"
-- is exactly what the transport office wants to know — but it has no arrival
-- time. So reached_at may now be empty, and a flag says which kind of row
-- this is. Averages over delay_s already ignore NULLs.
ALTER TABLE stop_events ADD COLUMN IF NOT EXISTS skipped boolean NOT NULL DEFAULT false;
ALTER TABLE stop_events ALTER COLUMN reached_at DROP NOT NULL;

-- The trail: the road the bus drove, as matched by the server. Kept so a
-- deploy or a restart mid-run does not wipe the line behind the bus.
--
-- Stored in pieces of at most 200 points. The trail only grows at its end, so
-- each 15-second mirror rewrites one short piece rather than the whole road.
--   seg    which stretch of the trail ('road' and 'gps' alternate at breaks)
--   piece  which 200-point piece of that stretch
CREATE TABLE IF NOT EXISTS trip_path (
  trip_id  bigint  NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  seg      integer NOT NULL,
  piece    integer NOT NULL,
  kind     text    NOT NULL,
  pts      jsonb   NOT NULL,
  PRIMARY KEY (trip_id, seg, piece)
);
