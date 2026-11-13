import pg from "pg";

export async function withPostgresClient<T>(databaseUrl: string, operationTimeoutMs: number, operation: (client: pg.Client) => Promise<T>) {
  const url = new URL(databaseUrl);
  url.searchParams.delete("query_timeout");
  const client = new pg.Client({
    connectionString: url.href,
    connectionTimeoutMillis: 5_000,
    query_timeout: operationTimeoutMs,
  });
  // Асинхронските грешки од конекцијата може да содржат детали за пристапот.
  client.on("error", () => {});
  const timeout = setTimeout(() => {
    client.connection.stream.destroy(new Error("Истече времето за PostgreSQL операцијата."));
  }, operationTimeoutMs);

  try {
    await client.connect();
    await client.query("SELECT set_config('statement_timeout', $1, false)", [String(operationTimeoutMs)]);
    return await operation(client);
  } finally {
    try {
      await client.end();
    } finally {
      clearTimeout(timeout);
    }
  }
}
