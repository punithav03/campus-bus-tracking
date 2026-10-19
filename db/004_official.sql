-- The college's real transport data: 9 buses, their stops, 286 students.
-- Additive only, safe to run more than once.

-- The registration number painted on the bus — what a student looks for.
ALTER TABLE routes ADD COLUMN IF NOT EXISTS bus_number text;

-- Stops now carry how sure we are of the pin, and whether the office listed
-- them at all.
--   verified  pinned by hand, seen on a recorded ride, or a mapped bus stop;
--             false = found by village name, or placed between neighbours
--   extra     a pickup point students gave that the bus passes but the
--             office's sheet does not list
--   sched_time the office's own time for the stop, 'HH:MM'
ALTER TABLE stops ADD COLUMN IF NOT EXISTS verified boolean NOT NULL DEFAULT true;
ALTER TABLE stops ADD COLUMN IF NOT EXISTS extra boolean NOT NULL DEFAULT false;
ALTER TABLE stops ADD COLUMN IF NOT EXISTS sched_time text;

-- What the student list said, kept so the office can see why a student was
-- put where they were and fix it.
--   pickup_text  the pickup point as the office typed it
--   review       null when the match was clean; otherwise what to check
ALTER TABLE students ADD COLUMN IF NOT EXISTS class text;
ALTER TABLE students ADD COLUMN IF NOT EXISTS pickup_text text;
ALTER TABLE students ADD COLUMN IF NOT EXISTS review text;
