import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type pg from "pg";
import { applyMigrations } from "../src/migrations.ts";
import { readTestTarget, verifyTestTarget, withTestDatabase } from "./test-database.ts";

const migrations = [
  "1794229200000_organizations",
  "1794229200001_auth",
  "1794229200002_contact_imports",
  "1794229200003_contact_suppressions",
  "1794229200004_contact_basis_events",
];
const productionFiles = "packages/db/migrations/*.sql";
const rollbackFiles = "packages/db/test/fixtures/rollback/*.sql";
const concurrentFiles = "packages/db/test/fixtures/concurrent/*.sql";

function runNode(databaseUrl: string, args: string[]) {
  return new Promise<{ code: number | string | null; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, args, {
      env: { ...process.env, DATABASE_ADMIN_URL: databaseUrl },
      encoding: "utf8",
      timeout: 25_000,
    }, (error, stdout, stderr) => resolve({ code: error ? error.code ?? null : 0, stdout, stderr }));
  });
}

function migrationCommand(databaseUrl: string, command: "up" | "status") {
  return runNode(databaseUrl, ["packages/db/src/migrate-cli.ts", command]);
}

async function history(client: pg.Client) {
  return (await client.query("SELECT id, name, run_on FROM public.pgmigrations ORDER BY id")).rows;
}

async function catalog(client: pg.Client) {
  return (await client.query(`
    SELECT nspname AS schema, relname AS relation
    FROM pg_namespace LEFT JOIN pg_class ON relnamespace = pg_namespace.oid
    WHERE nspname !~ '^pg_' AND nspname <> 'information_schema'
    ORDER BY nspname, relname
  `)).rows;
}

test("Миграции со локалниот PostgreSQL", { timeout: 90_000 }, async (suite) => {
  const target = verifyTestTarget();

  await suite.test("Недостасувачката и погрешно насочената тест-конфигурација се одбиваат", () => {
    const testUrl = target.adminUrl.href;
    const wrongPort = new URL(testUrl);
    wrongPort.port = target.project.port === "5433" ? "5434" : "5433";
    const wrongHost = new URL(testUrl);
    wrongHost.hostname = "192.0.2.1";
    assert.throws(() => readTestTarget({ ...process.env, TEST_DATABASE_ADMIN_URL: undefined }), /Поставете TEST_DATABASE_ADMIN_URL/);
    for (const invalid of [target.project.adminUrl.href, wrongHost.href, wrongPort.href, `${testUrl}?dbname=other`]) {
      assert.throws(() => readTestTarget({ ...process.env, TEST_DATABASE_ADMIN_URL: invalid }), /Тест-целта мора/);
    }
    assert.throws(() => readTestTarget({ ...process.env, DATABASE_ADMIN_URL: undefined }), /Недостасува DATABASE_ADMIN_URL/);
  });

  await withTestDatabase(target, async (client, databaseUrl) => {
    await suite.test("Статусот на празна база остава ист каталог на шеми и објекти", async () => {
      const before = await catalog(client);
      const status = await migrationCommand(databaseUrl, "status");
      assert.equal(status.code, 0, status.stderr);
      assert.match(status.stdout, /историја сè уште не постои/);
      assert.match(status.stdout, /Применети \(0\)/);
      assert.ok(status.stdout.includes(`За примена (${migrations.length}) — ${migrations.join(", ")}`));
      assert.deepEqual(await catalog(client), before);
    });

    await suite.test("Миграциите ги создаваат шемите и по еден запис во историјата", async () => {
      const applied = await migrationCommand(databaseUrl, "up");
      assert.equal(applied.code, 0, applied.stderr);
      assert.ok(applied.stdout.includes(`Применети миграции (${migrations.length}) — ${migrations.join(", ")}`));
      assert.deepEqual((await history(client)).map(({ name }) => name), migrations);
      assert.equal((await client.query("SELECT * FROM aevyra.organizations")).rowCount, 0);
      assert.equal((await client.query('SELECT id FROM aevyra_auth."user"')).rowCount, 0);
      for (const table of ["contacts", "contact_imports", "contact_import_contacts", "contact_suppressions", "contact_basis_events"]) {
        assert.equal((await client.query(`SELECT * FROM aevyra.${table}`)).rowCount, 0);
      }
      const status = await migrationCommand(databaseUrl, "status");
      assert.equal(status.code, 0, status.stderr);
      assert.ok(status.stdout.includes(`Применети (${migrations.length}) — ${migrations.join(", ")}`));
      assert.match(status.stdout, /За примена \(0\)/);
    });

    await suite.test("Две клиники и маркетинг-простор добиваат UUID, а повторната примена ги зачувува", async () => {
      const inserted = await client.query<{ id: string; kind: string; name: string; created_at: Date }>(`
        INSERT INTO aevyra.organizations (kind, name) VALUES
          ('CLINIC', 'Синтетичко име'), ('CLINIC', 'Синтетичко име'), ('MARKETING', 'Синтетички маркетинг')
        RETURNING id, kind, name, created_at
      `);
      assert.equal(inserted.rowCount, 3);
      const ids = inserted.rows.map(({ id }) => id);
      assert.equal(new Set(ids).size, 3);
      for (const row of inserted.rows) {
        assert.match(row.id, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
        assert.ok(row.created_at instanceof Date);
      }

      const before = await history(client);
      const repeated = await migrationCommand(databaseUrl, "up");
      assert.equal(repeated.code, 0, repeated.stderr);
      assert.match(repeated.stdout, /Нема нови миграции/);
      assert.deepEqual(await history(client), before);
      const preserved = await client.query("SELECT * FROM aevyra.organizations ORDER BY id");
      assert.deepEqual(preserved.rows, [...inserted.rows].sort((a, b) => a.id.localeCompare(b.id)));
    });

    await suite.test("PostgreSQL одбива невалиден вид и празни имиња", async () => {
      const insert = (kind: string | null, name: string | null) => client.query(
        "INSERT INTO aevyra.organizations (kind, name) VALUES ($1, $2)", [kind, name],
      );
      await assert.rejects(insert("OTHER", "Синтетичко име"), { code: "23514", constraint: "organizations_kind_check" });
      await assert.rejects(insert(null, "Синтетичко име"), { code: "23502", column: "kind" });
      await assert.rejects(insert("CLINIC", null), { code: "23502", column: "name" });
      for (const name of ["", "   ", "\t\n"]) {
        await assert.rejects(insert("CLINIC", name), { code: "23514", constraint: "organizations_name_not_blank" });
      }
    });
  });

  await withTestDatabase(target, async (client, databaseUrl) => {
    await suite.test("Грешката ги враќа шемите, табелите и евиденцијата на миграцискиот пакет", async () => {
      await assert.rejects(applyMigrations(databaseUrl, [productionFiles, rollbackFiles]), { code: "22012" });
      const result = await client.query(`
        SELECT to_regnamespace('aevyra') AS app, to_regnamespace('aevyra_auth') AS auth, to_regnamespace('rollback_probe') AS probe,
               to_regclass('aevyra.organizations') AS organizations, to_regclass('rollback_probe.marker') AS marker,
               to_regclass('aevyra.contacts') AS contacts, to_regclass('aevyra.contact_imports') AS imports,
               to_regclass('aevyra.contact_import_contacts') AS links,
               to_regclass('aevyra.contact_suppressions') AS suppressions,
               to_regclass('aevyra.contact_basis_events') AS basis_events
      `);
      assert.deepEqual(result.rows, [{
        app: null, auth: null, probe: null, organizations: null, marker: null,
        contacts: null, imports: null, links: null, suppressions: null, basis_events: null,
      }]);
      assert.deepEqual(await history(client), []);
    });

    await suite.test("Истовремената команда добива код 1, а првата ги применува миграциите еднаш", async () => {
      await client.query("SELECT pg_advisory_lock(2087469321)");
      const first = runNode(databaseUrl, ["--input-type=module", "--eval", `
        import { applyMigrations } from './packages/db/src/migrations.ts';
        try {
          const applied = await applyMigrations(process.env.DATABASE_ADMIN_URL, ${JSON.stringify([productionFiles, concurrentFiles])});
          console.log(applied.map(({ name }) => name).join(','));
        } catch {
          console.error('Првиот тест-процес не ја примени миграцијата.');
          process.exitCode = 1;
        }
      `]);
      let firstResult;
      try {
        const deadline = Date.now() + 10_000;
        let waiting = false;
        while (!waiting && Date.now() < deadline) {
          const result = await client.query(`
            SELECT EXISTS (SELECT 1 FROM pg_stat_activity
                           WHERE datname = current_database() AND pg_backend_pid() = ANY(pg_blocking_pids(pid))) AS waiting
          `);
          waiting = result.rows[0].waiting;
          if (!waiting) await delay(50);
        }
        assert.ok(waiting, "Првиот процес мора да е во миграциска трансакција пред да стартува вториот.");
        const second = await migrationCommand(databaseUrl, "up");
        assert.equal(second.code, 1);
        assert.match(second.stderr, /Друга миграција веќе се извршува/);
        assert.deepEqual(await history(client), []);
      } finally {
        try {
          await client.query("SELECT pg_advisory_unlock(2087469321)");
        } finally {
          firstResult = await first;
        }
      }
      assert.equal(firstResult.code, 0, firstResult.stderr);
      const expected = [
        ...migrations.slice(0, -2),
        "1794229200003_concurrent",
        ...migrations.slice(-2),
      ];
      assert.equal(firstResult.stdout.trim(), expected.join(","));
      assert.deepEqual((await history(client)).map(({ name }) => name), expected);
      assert.equal((await client.query("SELECT * FROM aevyra.organizations")).rowCount, 1);
    });
  });
});
