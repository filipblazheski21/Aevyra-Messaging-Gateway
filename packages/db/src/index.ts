import pg from "pg";

const connectionTimeoutMs = 1500;
const queryTimeoutMs = 1500;
const closeTimeoutMs = 250;

export async function checkDatabase(databaseUrl: string): Promise<boolean> {
  let client: pg.Client | undefined;
  try {
    const connectionUrl = new URL(databaseUrl);
    // Параметрите во адресата не смеат да ги сменат временските ограничувања на проверката.
    connectionUrl.searchParams.delete("query_timeout");
    connectionUrl.searchParams.delete("statement_timeout");
    client = new pg.Client({
      connectionString: connectionUrl.href,
      connectionTimeoutMillis: connectionTimeoutMs,
      query_timeout: queryTimeoutMs,
      statement_timeout: queryTimeoutMs,
    });
    client.on("error", () => {
      // Грешките од конекцијата се прикажуваат како недостапност, без детали од драјверот.
    });
    await client.connect();
    await client.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    if (client) {
      const { stream } = client.connection;
      const closeTimer = setTimeout(() => stream.destroy(), closeTimeoutMs);
      try {
        await client.end();
      } catch {
        stream.destroy();
      } finally {
        clearTimeout(closeTimer);
      }
    }
  }
}
