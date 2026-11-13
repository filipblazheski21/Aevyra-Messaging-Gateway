-- Up Migration
SELECT pg_advisory_xact_lock(2087469321);
INSERT INTO aevyra.organizations (kind, name) VALUES ('CLINIC', 'Синтетичка проверка на заклучување');
