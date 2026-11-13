import assert from "node:assert/strict";
import test from "node:test";
import { buildViberChatUrl } from "./viber-link.ts";

test("buildViberChatUrl генерира viber://chat линк за валиден E.164 број", () => {
  assert.equal(buildViberChatUrl("+38970123456"), "viber://chat?number=%2B38970123456");
  assert.equal(buildViberChatUrl("070123456"), null);
  assert.equal(buildViberChatUrl(""), null);
});
