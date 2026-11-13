export function GET() {
  return Response.json({ status: "активен" }, { headers: { "Cache-Control": "no-store" } });
}
