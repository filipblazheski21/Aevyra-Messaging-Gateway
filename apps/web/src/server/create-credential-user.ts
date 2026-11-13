import { ServerConfigError } from "@aevyra/config";
import { createAuth, maxPasswordLength, minPasswordLength } from "./auth-core.ts";
import type { readAuthSettings } from "./auth-settings.ts";

export async function createCredentialUser(
  adminUrl: string,
  settings: ReturnType<typeof readAuthSettings>,
  input: { name: string; email: string; password: string },
) {
  const name = input.name.trim();
  const email = input.email.trim().toLowerCase();
  const { password } = input;
  if (!name || name.length > 128 || !email || email.length > 254) {
    throw new ServerConfigError("Внесете валидно име и е-пошта.");
  }
  if (password.length < minPasswordLength || password.length > maxPasswordLength) {
    throw new ServerConfigError(`Лозинката мора да има од ${minPasswordLength} до ${maxPasswordLength} знаци.`);
  }

  let duplicate = false;
  const { auth, pool } = createAuth(adminUrl, settings, async () => { duplicate = true; });
  try {
    const result = await auth.api.signUpEmail({ body: { name, email, password } });
    if (duplicate) throw new ServerConfigError("Веќе постои корисник со таа е-пошта.");
    return result.user.id;
  } finally {
    await pool.end();
  }
}
