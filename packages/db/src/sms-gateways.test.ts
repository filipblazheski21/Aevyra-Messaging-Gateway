import assert from "node:assert/strict";
import { test } from "node:test";
import { nextGatewayName, rotationOrder } from "./sms-gateways.ts";

test("телефоните што никогаш не испраќале се први во редоследот", () => {
  const ordered = rotationOrder([
    { id: "1", name: "AEV-SMS-Z", lastUsedAt: "2026-11-14T10:00:00.000Z" },
    { id: "2", name: "AEV-SMS-L", lastUsedAt: null },
    { id: "3", name: "AEV-SMS-F", lastUsedAt: "2026-11-14T09:00:00.000Z" },
  ]);
  assert.deepEqual(ordered.map((gateway) => gateway.name), ["AEV-SMS-L", "AEV-SMS-F", "AEV-SMS-Z"]);
});

test("при изедначено време редоследот е азбучен и влезната низа останува непроменета", () => {
  const input = [
    { id: "1", name: "AEV-SMS-T", lastUsedAt: null },
    { id: "2", name: "AEV-SMS-L", lastUsedAt: null },
  ];
  const ordered = rotationOrder(input);
  assert.deepEqual(ordered.map((gateway) => gateway.name), ["AEV-SMS-L", "AEV-SMS-T"]);
  assert.deepEqual(input.map((gateway) => gateway.name), ["AEV-SMS-T", "AEV-SMS-L"]);
});

test("предлогот за име ги следи AEV-SMS-Z, L, F, T", () => {
  assert.equal(nextGatewayName([]), "AEV-SMS-Z");
  assert.equal(nextGatewayName(["AEV-SMS-Z"]), "AEV-SMS-L");
  assert.equal(nextGatewayName(["AEV-SMS-Z", "AEV-SMS-L"]), "AEV-SMS-F");
  assert.equal(nextGatewayName(["AEV-SMS-Z", "AEV-SMS-L", "AEV-SMS-F"]), "AEV-SMS-T");
  assert.equal(nextGatewayName(["AEV-SMS-Z", "AEV-SMS-L", "AEV-SMS-F", "AEV-SMS-T"]), "AEV-SMS-P");
});
