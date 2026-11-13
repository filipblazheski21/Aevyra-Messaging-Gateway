import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { ServerConfigError } from "@aevyra/config";
import { APIError } from "better-auth/api";
import { readLocalProjectDatabase, verifyLocalProjectDatabase } from "../../../packages/db/src/local-project.ts";
import { readAuthSettings } from "../src/server/auth-settings.ts";
import { createCredentialUser } from "../src/server/create-credential-user.ts";

async function promptForUser() {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new ServerConfigError("Создавањето корисник бара интерактивен терминал со скриен внес на лозинка.");
  }

  let hide = false;
  const output = new Writable({
    write(chunk, encoding, done) {
      if (hide) done();
      else stdout.write(chunk, encoding, done);
    },
  });
  const rl = createInterface({ input: stdin, output, terminal: true });
  const abort = new AbortController();
  rl.on("SIGINT", () => abort.abort());
  const options = { signal: abort.signal };
  try {
    const name = await rl.question("Име: ", options);
    const email = await rl.question("Е-пошта: ", options);
    stdout.write("Лозинка (скриен внес): ");
    hide = true;
    const password = await rl.question("", options);
    return { name, email, password };
  } finally {
    if (hide) stdout.write("\n");
    rl.close();
  }
}

try {
  if (process.argv.length !== 2) {
    throw new ServerConfigError("Користете auth:create-user без аргументи.");
  }
  const target = readLocalProjectDatabase();
  const settings = readAuthSettings();
  verifyLocalProjectDatabase(target);
  const input = await promptForUser();
  await createCredentialUser(target.adminUrl.href, settings, input);
  console.log("Корисникот е создаден.");
} catch (error) {
  let message = "Корисникот не е создаден. Проверете ги внесот, конфигурацијата и миграциите.";
  if (error instanceof ServerConfigError) message = error.message;
  else if (error instanceof APIError && error.body?.code === "INVALID_EMAIL") message = "Внесете валидна е-пошта.";
  else if (error instanceof Error && error.name === "AbortError") message = "Создавањето корисник е прекинато.";
  console.error(message);
  process.exitCode = 1;
}
