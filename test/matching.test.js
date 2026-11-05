'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { drawPool, buildPools, makeExcluder, isValidDraw, MatchError } = require('../server/lib/matching');

const range = (n) => Array.from({ length: n }, (_, i) => i + 1);

test('every size from 2 to 40 gives a valid draw with no self-match', () => {
  for (let n = 2; n <= 40; n += 1) {
    for (let k = 0; k < 20; k += 1) {
      const ids = range(n);
      const m = drawPool(ids);
      assert.ok(isValidDraw(ids, m), `n=${n}`);
    }
  }
});

test('three or more people never simply swap gifts, and form one circle', () => {
  for (let n = 3; n <= 25; n += 1) {
    const ids = range(n);
    const m = drawPool(ids);
    const childOf = new Map(m.map((x) => [x.santa, x.child]));
    for (const { santa, child } of m) assert.notEqual(childOf.get(child), santa, `swap at n=${n}`);
    // follow the circle from the first person: it must visit everybody
    let at = ids[0];
    const seen = new Set();
    do { seen.add(at); at = childOf.get(at); } while (at !== ids[0] && seen.size <= n);
    assert.equal(seen.size, n);
  }
});

test('odd and even pools both work (no "unequal number" problem)', () => {
  for (const n of [3, 5, 7, 4, 6]) assert.equal(drawPool(range(n)).length, n);
});

test('exclusions are honoured in both directions', () => {
  const ids = range(8);
  const pairs = [[1, 2], [3, 4], [5, 6], [1, 3]];
  const isEx = makeExcluder(pairs);
  for (let k = 0; k < 200; k += 1) {
    const m = drawPool(ids, isEx);
    assert.ok(isValidDraw(ids, m, isEx));
  }
});

test('heavy exclusions fall back to several circles but still solve', () => {
  // 1..6, where 1 may only give to 4 and 4 only to 1 is impossible without a swap,
  // so leave a solvable but tight set.
  const ids = range(6);
  const pairs = [[1, 2], [1, 3], [1, 5], [2, 3], [4, 5], [4, 6]];
  const isEx = makeExcluder(pairs);
  for (let k = 0; k < 50; k += 1) assert.ok(isValidDraw(ids, drawPool(ids, isEx, undefined, { tries: 3 }), isEx));
});

test('impossible pools are refused with a reason', () => {
  assert.throws(() => drawPool([7]), MatchError);
  assert.throws(() => drawPool([1, 2], makeExcluder([[1, 2]])), MatchError);
  // 1 is excluded from everyone
  assert.throws(() => drawPool(range(4), makeExcluder([[1, 2], [1, 3], [1, 4]])), MatchError);
  assert.deepEqual(drawPool([]), []);
});

test('two people simply exchange', () => {
  const m = drawPool([1, 2]);
  assert.ok(isValidDraw([1, 2], m));
});

test('pools: grouped by location, problems highlighted, merges respected', () => {
  const members = [
    { userId: 1, locationId: 10, locationName: 'North Pole' },
    { userId: 2, locationId: 10, locationName: 'North Pole' },
    { userId: 3, locationId: 10, locationName: 'North Pole' },
    { userId: 4, locationId: 20, locationName: 'Snowglobe City' },
    { userId: 5, locationId: 30, locationName: 'Candy Cane Lane' },
    { userId: 6, locationId: 30, locationName: 'Candy Cane Lane' },
    { userId: 7, locationId: null, locationName: null },
  ];
  const pools = buildPools(members, { scope: 'location', minGroupSize: 3 });
  const by = Object.fromEntries(pools.map((p) => [p.label, p]));
  assert.equal(by['North Pole'].level, 'ok');
  assert.equal(by['Snowglobe City'].level, 'error');
  assert.equal(by['Candy Cane Lane'].level, 'warn');
  assert.equal(by['No location yet'].level, 'error');
  assert.equal(pools[0].level, 'error', 'problems sort first');

  members[3].poolLocationId = 30;
  members[3].poolLocationName = 'Candy Cane Lane';
  const merged = buildPools(members, { scope: 'location', minGroupSize: 3 });
  const ccl = merged.find((p) => p.label === 'Candy Cane Lane');
  assert.equal(ccl.count, 3);
  assert.equal(ccl.level, 'ok');
  assert.ok(ccl.merged);
  assert.equal(merged.find((p) => p.label === 'Snowglobe City'), undefined);

  const all = buildPools(members, { scope: 'all', minGroupSize: 3 });
  assert.equal(all.length, 1);
  assert.equal(all[0].count, 7);
  assert.equal(all[0].level, 'ok');
});
