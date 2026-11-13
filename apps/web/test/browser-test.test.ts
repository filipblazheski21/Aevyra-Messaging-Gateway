import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import {
  browserProcessIdsForProfile,
  BrowserCleanupError,
  BrowserTestError,
  withBrowser,
} from "./browser-test.ts";

async function assertProfileCleaned(profile: string) {
  assert.ok(profile, "Тестот мора да ја забележи патеката на сопствениот профил.");
  assert.equal(existsSync(profile), false, "Профилот на тест-прелистувачот мора да биде избришан.");
  assert.deepEqual(await browserProcessIdsForProfile(profile), [], "Не смеат да останат процеси за тест-профилот.");
}

test("тест-прелистувачот успешно се стартува и целосно се затвора", async () => {
  let profile = "";

  await withBrowser(async (browser) => {
    assert.equal(await browser.evaluate<number>("1 + 1"), 2);
    assert.ok(
      (await browserProcessIdsForProfile(profile)).length > 0,
      "Активниот Chrome мора да има процеси врзани за точниот тековен профил.",
    );
  }, { onProfileCreated: (createdProfile) => { profile = createdProfile; } });

  await assertProfileCleaned(profile);
});

test("намерна грешка во сценарио ја задржува причината и сепак чисти", async () => {
  let profile = "";
  const scenarioFailure = new Error("Намерна грешка во тест-сценариото.");

  await assert.rejects(
    withBrowser(async () => { throw scenarioFailure; }, {
      onProfileCreated: (createdProfile) => { profile = createdProfile; },
    }),
    (error) => error === scenarioFailure,
  );

  await assertProfileCleaned(profile);
});

test("првичната причина се зачувува и кога ќе се јави грешка при чистење", async () => {
  let profile = "";
  const scenarioFailure = new Error("Првична синтетичка причина.");
  const cleanupFailure = new BrowserCleanupError("Синтетичка грешка при чистење.");

  await assert.rejects(
    withBrowser(async () => { throw scenarioFailure; }, {
      onProfileCreated: (createdProfile) => { profile = createdProfile; },
      afterCleanup: () => { throw cleanupFailure; },
    }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors[0], scenarioFailure);
      assert.equal(error.errors[1], cleanupFailure);
      return true;
    },
  );

  await assertProfileCleaned(profile);
});

test("неуспешно стартување по создаден профил сепак го чисти профилот", async () => {
  let profile = "";
  const launchFailure = new BrowserTestError("Синтетичка грешка при стартување.");

  await assert.rejects(
    withBrowser(async () => undefined, {
      onProfileCreated: (createdProfile) => {
        profile = createdProfile;
        throw launchFailure;
      },
    }),
    (error) => error === launchFailure,
  );

  await assertProfileCleaned(profile);
});
