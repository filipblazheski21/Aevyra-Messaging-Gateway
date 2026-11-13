import { handleAuthPost } from "../../../../server/auth-http.ts";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return handleAuthPost(request, "sign-out");
}
