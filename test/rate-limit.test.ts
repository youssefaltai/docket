// The rate limiter's buckets, directly: the HTTP tests all come from one IP, so they can't show that many clients
// don't grow the map without bound (DKT-40).
import { expect, test } from "bun:test";
import { tokenBuckets } from "../src/server/http.ts";

test("a burst, then a wait; refilling over time", () => {
  const buckets = tokenBuckets();
  for (let i = 0; i < 600; i++) expect(buckets.take("ip:a", 0)).toBe(0);
  expect(buckets.take("ip:a", 0)).toBe(1);
  expect(buckets.take("ip:a", 1000)).toBe(0); // 20 a second
  expect(buckets.take("ip:b", 0)).toBe(0); // another client has its own
});

test("past the cap, clients whose buckets have refilled since they were used are forgotten", () => {
  const buckets = tokenBuckets(1000);
  for (let i = 0; i < 1000; i++) buckets.take(`ip:${i}`, 0);
  expect(buckets.size).toBe(1000);
  buckets.take("ip:late", 60_000); // a minute on, every one of them is full again
  expect(buckets.size).toBe(1);
});

test("many clients at once can't grow it past the cap", () => {
  const buckets = tokenBuckets(1000);
  for (let i = 0; i < 20_000; i++) {
    buckets.take(`ip:${i}`, 0);
    if (buckets.size > 1000) throw new Error(`${buckets.size} buckets after ${i + 1} clients`);
  }
});
