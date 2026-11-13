import { getDatabaseStatus } from "../../../../server/database-status.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const database = await getDatabaseStatus();
  return Response.json(
    database.ready
      ? { status: "достапна", message: "Базата на податоци е достапна." }
      : { status: "недостапна", message: "Базата на податоци е недостапна." },
    { status: database.ready ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
