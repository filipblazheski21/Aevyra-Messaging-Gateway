import { getCurrentUser } from "../../../server/auth.ts";
import { authCacheControl } from "../../../server/auth-http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const user = await getCurrentUser(request.headers);
  const headers = { "Cache-Control": authCacheControl };
  if (!user) return Response.json({ message: "Потребна е најава." }, { status: 401, headers });
  return Response.json(user, { headers });
}
