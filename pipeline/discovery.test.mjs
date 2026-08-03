import test from "node:test";
import assert from "node:assert";
import { isValidSubnet, normalizeSubnetInput, scanSubnet, assignStablePrinterIds } from "./discovery.mjs";

test("isValidSubnet accepts RFC1918 /24 prefixes", () => {
  assert.equal(isValidSubnet("192.168.137"), true);
  assert.equal(isValidSubnet("10.0.0"), true);
  assert.equal(isValidSubnet("172.16.5"), true);
  assert.equal(isValidSubnet("172.31.255"), true);
});

test("isValidSubnet rejects public and malformed prefixes", () => {
  assert.equal(isValidSubnet("8.8.8"), false);
  assert.equal(isValidSubnet("172.15.1"), false);
  assert.equal(isValidSubnet("172.32.1"), false);
  assert.equal(isValidSubnet("192.169.1"), false);
  assert.equal(isValidSubnet("192.168"), false);
  assert.equal(isValidSubnet("192.168.1.1"), false);
  assert.equal(isValidSubnet("192.168.256"), false);
  assert.equal(isValidSubnet("abc.def.ghi"), false);
});

test("normalizeSubnetInput accepts a pasted printer IP", () => {
  assert.equal(normalizeSubnetInput("192.168.137"), "192.168.137");
  assert.equal(normalizeSubnetInput("192.168.137.70"), "192.168.137");
  assert.equal(normalizeSubnetInput("172.20.10.2"), "172.20.10");
});

test("normalizeSubnetInput rejects public or malformed input", () => {
  assert.throws(() => normalizeSubnetInput("138.234.1.1"), /Not a private network/);
  assert.throws(() => normalizeSubnetInput(""), /Not a private network/);
  assert.throws(() => normalizeSubnetInput("192.168.1.999"), /Not a private network/);
  assert.throws(() => normalizeSubnetInput("192.168..1"), /Not a private network/);
});

test("scanSubnet refuses to scan a public subnet", async () => {
  await assert.rejects(
    () => scanSubnet("8.8.8", { start: 1, end: 1, timeoutMs: 10, concurrency: 1 }),
    /Invalid or unsupported subnet/
  );
});

test("scanSubnet returns nothing when every probe is unreachable", async () => {
  const result = await scanSubnet("192.168.254", {
    start: 254, end: 254, timeoutMs: 10, concurrency: 1,
    probeFn: async (printer) => ({ ...printer, status: "unreachable", job: "-" })
  });

  assert.equal(result.subnet, "192.168.254");
  assert.deepEqual(result.found, []);
  assert.equal(result.scanned, 1);
  assert.ok(result.durationMs >= 0);
});

test("scanSubnet retries a printer that misses the first pass", async () => {
  let calls = 0;
  const result = await scanSubnet("192.168.137", {
    start: 70, end: 70, timeoutMs: 10, concurrency: 1, attempts: 2,
    probeFn: async (printer) => {
      calls += 1;
      if (calls === 1) return { ...printer, status: "unreachable", job: "-" };
      return { ...printer, status: "online", job: { deviceState: 0, hostname: "Ender3V3KE-9E9F" } };
    }
  });

  assert.equal(calls, 2, "the slow printer gets a second chance");
  assert.equal(result.found.length, 1);
  assert.equal(result.found[0].ip, "192.168.137.70");
});

test("scanSubnet sorts found printers by last IP octet", async () => {
  const online = new Set(["192.168.137.184", "192.168.137.70", "192.168.137.215"]);
  const result = await scanSubnet("192.168.137", {
    start: 70, end: 215, timeoutMs: 10, concurrency: 64, attempts: 1,
    probeFn: async (printer) => online.has(printer.ip)
      ? { ...printer, status: "online", job: { deviceState: 0 } }
      : { ...printer, status: "unreachable", job: "-" }
  });

  assert.deepEqual(result.found.map((p) => p.ip), [
    "192.168.137.70",
    "192.168.137.184",
    "192.168.137.215"
  ]);
});

test("assignStablePrinterIds keeps a printer's letter across scans", () => {
  const prior = [
    { id: "A", ip: "192.168.137.70", hostname: "KE-AAA" },
    { id: "B", ip: "192.168.137.184", hostname: "KE-BBB" }
  ];
  // Same two printers come back on swapped DHCP leases, in the other order.
  const found = [
    { ip: "192.168.137.184", job: { hostname: "KE-AAA" } },
    { ip: "192.168.137.70", job: { hostname: "KE-BBB" } }
  ];

  const labelled = assignStablePrinterIds(found, prior);
  assert.equal(labelled[0].id, "A", "hostname KE-AAA keeps letter A on its new IP");
  assert.equal(labelled[1].id, "B");
});

test("assignStablePrinterIds gives unknown printers the next free letter", () => {
  const prior = [{ id: "A", ip: "192.168.137.70", hostname: "KE-AAA" }];
  const found = [
    { ip: "192.168.137.70", job: { hostname: "KE-AAA" } },
    { ip: "192.168.137.215", job: { hostname: "KE-NEW" } },
    { ip: "192.168.137.240", job: {} }
  ];

  assert.deepEqual(assignStablePrinterIds(found, prior).map((p) => p.id), ["A", "B", "C"]);
});
