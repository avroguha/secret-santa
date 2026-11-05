'use strict';
// The draw. Pure functions, no database, so the rules can be tested directly.
//
// Within each pool (a location, or everyone) people are arranged in ONE
// random circle: each person is the Santa of the next. A circle can never
// match anyone with themselves, never makes two people swap gifts (when the
// pool has three or more), and works for any pool size from two up - odd or
// even makes no difference. Exclusion pairs (partners, a manager and their
// report) are honoured in both directions. When exclusions make a single
// circle impossible, a randomised search finds several smaller circles
// instead, still with no swaps.
const crypto = require('node:crypto');

const cryptoRng = { int: (n) => crypto.randomInt(n) };

class MatchError extends Error {}

function shuffle(list, rng = cryptoRng) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = rng.int(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const pairKey = (a, b) => (a < b ? `${a}:${b}` : `${b}:${a}`);

function makeExcluder(pairs = []) {
  const set = new Set(pairs.map(([a, b]) => pairKey(a, b)));
  return (a, b) => set.has(pairKey(a, b));
}

function searchCircles(ids, isExcluded, rng, budget = 200000) {
  const n = ids.length;
  const order = shuffle(ids, rng);
  const childOf = new Map();
  const taken = new Set();
  let steps = 0;
  const go = (i) => {
    if (i === n) return true;
    steps += 1;
    if (steps > budget) return false;
    const santa = order[i];
    for (const child of shuffle(ids, rng)) {
      if (child === santa || taken.has(child) || isExcluded(santa, child)) continue;
      if (childOf.get(child) === santa) continue; // would be a swap
      childOf.set(santa, child);
      taken.add(child);
      if (go(i + 1)) return true;
      childOf.delete(santa);
      taken.delete(child);
    }
    return false;
  };
  return go(0) ? order.map((s) => ({ santa: s, child: childOf.get(s) })) : null;
}

function drawPool(ids, isExcluded = () => false, rng = cryptoRng, { tries = 4000 } = {}) {
  const n = ids.length;
  if (n === 0) return [];
  if (n === 1) throw new MatchError('has only one person, who cannot be their own Santa');
  if (n === 2) {
    if (isExcluded(ids[0], ids[1])) throw new MatchError('has only two people and they are excluded from each other');
    return [{ santa: ids[0], child: ids[1] }, { santa: ids[1], child: ids[0] }];
  }
  for (let t = 0; t < tries; t += 1) {
    const order = shuffle(ids, rng);
    let ok = true;
    for (let i = 0; i < n; i += 1) {
      if (isExcluded(order[i], order[(i + 1) % n])) {
        ok = false;
        break;
      }
    }
    if (ok) return order.map((s, i) => ({ santa: s, child: order[(i + 1) % n] }));
  }
  const found = searchCircles(ids, isExcluded, rng);
  if (!found) throw new MatchError('cannot be matched: the exclusions leave no valid way to pair everyone');
  return found;
}

// Group a team's members into the pools that are drawn separately, and say
// what is wrong with each. members: [{ userId, name, locationId, locationName,
// poolLocationId, poolLocationName }] where locationId is already resolved
// (team override, else profile location).
function buildPools(members, { scope = 'location', minGroupSize = 3 } = {}) {
  const pools = new Map();
  for (const m of members) {
    let key;
    let label;
    let locationId = null;
    if (scope === 'all') {
      key = 'all';
      label = 'Everyone';
    } else {
      const loc = m.poolLocationId || m.locationId || null;
      if (!loc) {
        key = 'none';
        label = 'No location yet';
      } else {
        key = `loc:${loc}`;
        locationId = loc;
        label = m.poolLocationId ? m.poolLocationName : m.locationName;
      }
    }
    if (!pools.has(key)) pools.set(key, { key, label, locationId, members: [], from: new Map() });
    const pool = pools.get(key);
    pool.members.push(m);
    const from = m.locationName || 'No location';
    pool.from.set(from, (pool.from.get(from) || 0) + 1);
  }

  const out = [];
  for (const pool of pools.values()) {
    const n = pool.members.length;
    const issues = [];
    let level = 'ok';
    if (pool.key === 'none') {
      level = 'error';
      issues.push(`${n} ${n === 1 ? 'person has' : 'people have'} no location yet. Ask them to pick one, set it for them, or match everyone together.`);
    } else if (n === 1) {
      level = 'error';
      issues.push('Only one person here - they cannot be matched. Merge this location into another one.');
    } else if (n === 2) {
      level = 'warn';
      issues.push('Only two people - they would simply swap gifts and both know their Santa. Consider merging.');
    } else if (n < minGroupSize) {
      level = 'warn';
      issues.push(`Smaller than this team's minimum of ${minGroupSize} - with so few people it is easy to guess your Santa.`);
    }
    out.push({
      key: pool.key,
      label: pool.label,
      locationId: pool.locationId,
      count: n,
      level,
      issues,
      merged: pool.from.size > 1 || pool.members.some((m) => m.poolLocationId && m.poolLocationId !== m.locationId),
      from: [...pool.from.entries()].map(([name, count]) => ({ name, count })),
      memberIds: pool.members.map((m) => m.userId),
    });
  }
  const rank = { error: 0, warn: 1, ok: 2 };
  out.sort((a, b) => rank[a.level] - rank[b.level] || b.count - a.count || String(a.label).localeCompare(String(b.label)));
  return out;
}

// Check that a set of matches is a valid draw for these ids.
function isValidDraw(ids, matches, isExcluded = () => false) {
  const set = new Set(ids);
  const santas = new Set();
  const children = new Set();
  for (const { santa, child } of matches) {
    if (!set.has(santa) || !set.has(child) || santa === child || isExcluded(santa, child)) return false;
    if (santas.has(santa) || children.has(child)) return false;
    santas.add(santa);
    children.add(child);
  }
  return santas.size === set.size && children.size === set.size;
}

module.exports = { drawPool, buildPools, makeExcluder, shuffle, isValidDraw, MatchError, cryptoRng, pairKey };
