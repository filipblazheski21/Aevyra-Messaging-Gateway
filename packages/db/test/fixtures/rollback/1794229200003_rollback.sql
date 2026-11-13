-- Up Migration
CREATE SCHEMA rollback_probe;
CREATE TABLE rollback_probe.marker (id integer);
SELECT 1 / 0;
