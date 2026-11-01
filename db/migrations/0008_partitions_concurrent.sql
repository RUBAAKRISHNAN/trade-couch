-- Two workers can run the partition job at the same moment (e.g. during a restart). The old function checked
-- "does it exist?" then created it, so both could see "no" and the second CREATE failed. Now each partition is
-- created with IF NOT EXISTS, and a concurrent creator's duplicate_table error is treated as success.
CREATE OR REPLACE FUNCTION ensure_daily_partitions(parent regclass, from_day date, days int)
RETURNS int LANGUAGE plpgsql AS $$
DECLARE
  d date;
  created int := 0;
  part text;
BEGIN
  FOR i IN 0 .. days - 1 LOOP
    d := from_day + i;
    part := format('%s_%s', parent::text, to_char(d, 'YYYYMMDD'));
    IF to_regclass(part) IS NULL THEN
      BEGIN
        EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF %s FOR VALUES FROM (%L) TO (%L)',
                       part, parent, d::timestamptz, (d + 1)::timestamptz);
        created := created + 1;
      EXCEPTION WHEN duplicate_table OR unique_violation THEN
        NULL; -- another session created it first
      END;
    END IF;
  END LOOP;
  RETURN created;
END $$;
