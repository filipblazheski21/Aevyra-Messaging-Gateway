import { getCurrentUser, getCurrentUserStrict, getRuntimeAuth } from "./auth.ts";
import { authCacheControl } from "./auth-http.ts";
import { ContactListError } from "./contacts.ts";
import { OrganizationError } from "./organizations.ts";

export async function organizationResponse(
  request: Request, action: (operator: NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>) => Promise<unknown>, successStatus = 200,
  options?: { strictSession?: boolean; unavailableMessage?: string },
) {
  const reply = (data: unknown, status: number) => Response.json(data, {
    status, headers: { "Cache-Control": authCacheControl },
  });

  let operator;
  try {
    operator = options?.strictSession ? await getCurrentUserStrict(request.headers) : await getCurrentUser(request.headers);
  } catch {
    return reply({
      code: "TEMPORARILY_UNAVAILABLE",
      message: options?.unavailableMessage ?? "Регистарот моментално е недостапен. Обидете се повторно.",
    }, 503);
  }
  if (!operator) return reply({ code: "AUTH_REQUIRED", message: "Потребна е најава." }, 401);
  try {
    if (request.method !== "GET" && request.headers.get("origin") !== getRuntimeAuth().baseURL) {
      return reply({ code: "ORIGIN_DENIED", message: "Потеклото на барањето не е дозволено." }, 403);
    }
    const result = await action(operator);
    if (result instanceof Response) {
      result.headers.set("Cache-Control", authCacheControl);
      return result;
    }
    return reply(result, successStatus);
  } catch (error) {
    if (error instanceof OrganizationError) {
      return reply({ code: error.status === 404 ? "ORGANIZATION_NOT_FOUND" : "INVALID_REQUEST", message: error.message }, error.status);
    }
    if (error instanceof ContactListError) {
      return reply({ code: "INVALID_REQUEST", message: error.message }, 400);
    }
    return reply({
      code: "TEMPORARILY_UNAVAILABLE",
      message: options?.unavailableMessage ?? "Регистарот моментално е недостапен. Обидете се повторно.",
    }, 503);
  }
}

export async function readOrganizationBody(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new OrganizationError("Испратете го барањето во JSON формат.");
  }
  return request.json().catch(() => null);
}
