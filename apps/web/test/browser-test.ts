import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const profilePrefix = "aevyra-ui-test-";
const browserStartTimeoutMs = 10_000;
const browserCloseTimeoutMs = 5_000;
const browserCommandTimeoutMs = 15_000;
const processCheckIntervalMs = 100;

async function reserveDebugPort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolvePromise) => server.once("listening", resolvePromise));
  const address = server.address();
  if (!address || typeof address === "string") throw new BrowserTestError("Тест-портата за Chrome не е достапна.");
  await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
  return address.port;
}

export class BrowserTestError extends Error {}
export class BrowserCleanupError extends Error {}

export function combineTestFailures(primary: unknown, cleanup: unknown, message: string): unknown {
  if (primary === undefined) return cleanup;
  if (cleanup === undefined) return primary;
  return new AggregateError([primary, cleanup], message);
}

type PendingCommand = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export type BrowserDriver = {
  addScript: (source: string) => Promise<string>;
  captureScreenshot: () => Promise<Buffer>;
  evaluate: <Value>(expression: string) => Promise<Value>;
  navigate: (url: string) => Promise<void>;
  removeScript: (identifier: string) => Promise<void>;
  setViewport: (width: number, height: number) => Promise<void>;
  waitFor: (expression: string, message: string) => Promise<void>;
};

export type BrowserTestHooks = {
  onProfileCreated?: (profile: string) => void;
  afterCleanup?: () => void;
};

const processScript = String.raw`
$profilePath = $env:AEVYRA_TEST_BROWSER_PROFILE
$action = $env:AEVYRA_TEST_BROWSER_ACTION
$escapedProfile = [System.Text.RegularExpressions.Regex]::Escape($profilePath)
$profileArgument = '(?:^|\s)--user-data-dir=(?:"' + $escapedProfile + '"|' + $escapedProfile + ')(?:\s|$)'
$owned = @(Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" -ErrorAction Stop | Where-Object {
  $_.CommandLine -and [System.Text.RegularExpressions.Regex]::IsMatch(
    $_.CommandLine,
    $profileArgument,
    [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
  )
})
if ($action -eq 'stop') {
  foreach ($item in $owned) { Stop-Process -Id $item.ProcessId -Force -ErrorAction SilentlyContinue }
}
[Console]::Out.Write((($owned | ForEach-Object { [string]$_.ProcessId }) -join ','))
`;

function runProcessCheck(profile: string, action: "list" | "stop") {
  return new Promise<number[]>((resolvePromise, reject) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", processScript], {
      env: {
        ...process.env,
        AEVYRA_TEST_BROWSER_ACTION: action,
        AEVYRA_TEST_BROWSER_PROFILE: profile,
      },
      windowsHide: true,
      timeout: browserCloseTimeoutMs,
      maxBuffer: 16 * 1024,
    }, (error, stdout) => {
      if (error) {
        reject(new BrowserCleanupError("Не може безбедно да се проверат процесите на тест-прелистувачот.", { cause: error }));
        return;
      }
      const output = stdout.trim();
      if (output === "") {
        resolvePromise([]);
        return;
      }
      const processIds = output.split(",").map(Number);
      if (processIds.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
        reject(new BrowserCleanupError("Проверката на процесите на тест-прелистувачот врати невалиден резултат."));
        return;
      }
      resolvePromise(processIds);
    });
  });
}

export function browserProcessIdsForProfile(profile: string) {
  return runProcessCheck(resolve(profile), "list");
}

async function waitForOwnedProcessesToExit(profile: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let processIds = await browserProcessIdsForProfile(profile);
  while (processIds.length > 0 && Date.now() < deadline) {
    await delay(processCheckIntervalMs);
    processIds = await browserProcessIdsForProfile(profile);
  }
  return processIds;
}

async function validateProfileForDeletion(profile: string) {
  const expectedRoot = await realpath(tmpdir());
  const resolvedProfile = resolve(profile);
  if (dirname(resolvedProfile).toLowerCase() !== resolve(expectedRoot).toLowerCase()
      || !new RegExp(`^${profilePrefix}[A-Za-z0-9_-]+$`).test(basename(resolvedProfile))) {
    throw new BrowserCleanupError("Патеката на тест-профилот не е безбедна за чистење.");
  }
  if (!existsSync(resolvedProfile)) return resolvedProfile;
  const metadata = await lstat(resolvedProfile).catch((error: unknown) => {
    throw new BrowserCleanupError("Не може да се провери тест-профилот пред чистење.", { cause: error });
  });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new BrowserCleanupError("Тест-профилот не е обична папка.");
  }
  const canonicalProfile = await realpath(resolvedProfile).catch((error: unknown) => {
    throw new BrowserCleanupError("Не може да се разреши тест-профилот пред чистење.", { cause: error });
  });
  if (canonicalProfile.toLowerCase() !== resolvedProfile.toLowerCase()
      || dirname(canonicalProfile).toLowerCase() !== resolve(expectedRoot).toLowerCase()) {
    throw new BrowserCleanupError("Тест-профилот е небезбедно пренасочен.");
  }
  return resolvedProfile;
}

async function removeProfile(profile: string) {
  const safeProfile = await validateProfileForDeletion(profile);
  if (!existsSync(safeProfile)) return;
  let lastError: unknown;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await rm(safeProfile, { recursive: true, force: true });
      if (!existsSync(safeProfile)) return;
    } catch (error) {
      lastError = error;
    }
    await delay(200);
  }
  throw new BrowserCleanupError("Папката на тест-прелистувачот не може да се исчисти.", { cause: lastError });
}

function childCompletion(child: ChildProcess) {
  let finished = false;
  let launchError: Error | undefined;
  const closed = new Promise<void>((resolvePromise) => {
    const complete = () => {
      if (!finished) {
        finished = true;
        resolvePromise();
      }
    };
    child.once("error", (error) => {
      launchError = error;
      complete();
    });
    child.once("close", complete);
  });
  return { closed, isFinished: () => finished, launchError: () => launchError };
}

async function waitForCompletion(closed: Promise<void>, isFinished: () => boolean, timeoutMs: number) {
  if (isFinished()) return true;
  await Promise.race([closed, delay(timeoutMs)]);
  return isFinished();
}

async function cleanupBrowser(profile: string, child: ChildProcess | undefined, completion: ReturnType<typeof childCompletion> | undefined,
  socket: WebSocket | undefined, nextCommandId: () => number) {
  if (socket?.readyState === WebSocket.OPEN) {
    try {
      socket.send(JSON.stringify({ id: nextCommandId(), method: "Browser.close", params: {} }));
    } catch {
      // Резервното запирање подолу останува ограничено на тековниот профил.
    }
  }

  if (completion) await waitForCompletion(completion.closed, completion.isFinished, browserCloseTimeoutMs);
  let remaining = await waitForOwnedProcessesToExit(profile, browserCloseTimeoutMs);
  if (remaining.length > 0) {
    await runProcessCheck(profile, "stop");
    remaining = await waitForOwnedProcessesToExit(profile, browserCloseTimeoutMs);
  }
  if (remaining.length > 0) {
    throw new BrowserCleanupError("Останаа процеси од тековниот тест-прелистувач по резервното запирање.");
  }
  if (child && completion && !completion.isFinished()) {
    child.kill();
    if (!await waitForCompletion(completion.closed, completion.isFinished, browserCloseTimeoutMs)) {
      throw new BrowserCleanupError("Главниот процес на тест-прелистувачот не заврши во дозволениот рок.");
    }
  }
  socket?.close();
  await removeProfile(profile);
}

export async function withBrowser<T>(run: (browser: BrowserDriver) => Promise<T>, testHooks: BrowserTestHooks = {}) {
  if (!existsSync(chromePath)) throw new BrowserTestError("Регресискиот UI тест бара инсталиран Google Chrome.");
  let profile: string | undefined;
  let child: ChildProcess | undefined;
  let completion: ReturnType<typeof childCompletion> | undefined;
  let socket: WebSocket | undefined;
  let result: T | undefined;
  let failure: unknown;
  let cleanupFailure: unknown;
  let commandId = 0;
  const nextCommandId = () => ++commandId;

  try {
    const profileRoot = await realpath(tmpdir());
    profile = await mkdtemp(join(profileRoot, profilePrefix));
    await validateProfileForDeletion(profile);
    testHooks.onProfileCreated?.(profile);
    const debugPort = await reserveDebugPort();
    child = spawn(chromePath, [
      "--headless=new", `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`,
      "--disable-background-mode", "--disable-background-networking", "--disable-component-update",
      "--disable-default-apps", "--no-first-run", "about:blank",
    ], { stdio: "ignore", windowsHide: true });
    completion = childCompletion(child);

    let version: { webSocketDebuggerUrl: string } | undefined;
    const startDeadline = Date.now() + browserStartTimeoutMs;
    while (!version && !completion.isFinished() && Date.now() < startDeadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`, { signal: AbortSignal.timeout(500) });
        if (response.ok) version = await response.json();
      } catch {
        // Chrome сè уште не ја отворил локалната DevTools адреса.
      }
      if (!version) await delay(100);
    }
    if (completion.launchError()) {
      throw new BrowserTestError("Тест-прелистувачот не може да се стартува.", { cause: completion.launchError() });
    }
    if (!version) throw new BrowserTestError("Тест-прелистувачот не се стартуваше во дозволениот рок.");

    const targetResponse = await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent("about:blank")}`, {
      method: "PUT", signal: AbortSignal.timeout(2_000),
    });
    if (!targetResponse.ok) throw new BrowserTestError("Тест-прелистувачот не отвори изолиран таб.");
    const target = await targetResponse.json() as { webSocketDebuggerUrl: string };
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((resolvePromise, reject) => {
      const timeout = setTimeout(() => reject(new BrowserTestError("Не може навреме да се отвори тест-прелистувачот.")), 2_000);
      socket!.addEventListener("open", () => { clearTimeout(timeout); resolvePromise(); }, { once: true });
      socket!.addEventListener("error", () => { clearTimeout(timeout); reject(new BrowserTestError("Не може да се отвори тест-прелистувачот.")); }, { once: true });
    });

    const pending = new Map<number, PendingCommand>();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) return;
      const command = pending.get(message.id);
      if (!command) return;
      pending.delete(message.id);
      clearTimeout(command.timeout);
      if (message.error) command.reject(new BrowserTestError(message.error.message));
      else command.resolve(message.result);
    });
    const send = <Value>(method: string, params: Record<string, unknown> = {}) => new Promise<Value>((resolvePromise, reject) => {
      const id = nextCommandId();
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new BrowserTestError(`Тест-прелистувачот не одговори навреме на ${method}.`));
      }, browserCommandTimeoutMs);
      pending.set(id, { resolve: resolvePromise as (value: unknown) => void, reject, timeout });
      try {
        socket!.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timeout);
        pending.delete(id);
        reject(new BrowserTestError("Командата до тест-прелистувачот не може да се испрати.", { cause: error }));
      }
    });
    const evaluate = async <Value>(expression: string) => {
      const response = await send<{ result: { value: Value }; exceptionDetails?: unknown }>("Runtime.evaluate", {
        expression, awaitPromise: true, returnByValue: true,
      });
      if (response.exceptionDetails) throw new BrowserTestError(`UI изразот не успеа: ${expression}`);
      return response.result.value;
    };
    const waitFor = async (expression: string, message: string) => {
      for (let attempt = 0; attempt < 150; attempt++) {
        if (await evaluate<boolean>(expression)) return;
        await delay(100);
      }
      throw new BrowserTestError(message);
    };
    const navigate = async (url: string) => {
      await send("Page.navigate", { url });
      await waitFor("document.readyState === 'complete'", "Страницата не се вчита.");
    };
    const addScript = async (source: string) => (await send<{ identifier: string }>(
      "Page.addScriptToEvaluateOnNewDocument", { source },
    )).identifier;
    const removeScript = async (identifier: string) => { await send("Page.removeScriptToEvaluateOnNewDocument", { identifier }); };
    const captureScreenshot = async () => Buffer.from((await send<{ data: string }>(
      "Page.captureScreenshot", { format: "png", fromSurface: true },
    )).data, "base64");
    const setViewport = async (width: number, height: number) => {
      await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 600 });
    };
    await send("Page.enable");
    await send("Runtime.enable");
    result = await run({ addScript, captureScreenshot, evaluate, navigate, removeScript, setViewport, waitFor });
  } catch (error) {
    failure = error;
  } finally {
    if (profile) {
      try {
        await cleanupBrowser(profile, child, completion, socket, nextCommandId);
        testHooks.afterCleanup?.();
      } catch (error) {
        cleanupFailure = error instanceof BrowserCleanupError
          ? error
          : new BrowserCleanupError("Чистењето на тест-прелистувачот не успеа.", { cause: error });
      }
    }
  }
  const finalFailure = combineTestFailures(
    failure,
    cleanupFailure,
    "Тест-сценариото не успеа, а потоа не успеа ни чистењето на тест-прелистувачот.",
  );
  if (finalFailure !== undefined) throw finalFailure;
  return result as T;
}
