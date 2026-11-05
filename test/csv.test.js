'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCsv, toCsv } = require('../server/lib/csv');
const { mapHeader } = require('../server/services/users');

test('quoted fields, escaped quotes, embedded commas and line breaks, BOM, CRLF', () => {
  const rows = parseCsv('﻿userName,ID,email\r\n"Frost, Jack",E1,"jack@example.com"\r\n"Say ""hi""",E2,"a\nb@x.com"\r\n\r\n');
  assert.deepEqual(rows, [['userName', 'ID', 'email'], ['Frost, Jack', 'E1', 'jack@example.com'], ['Say "hi"', 'E2', 'a\nb@x.com']]);
});

test('semicolon and tab separated files (Excel in many locales)', () => {
  assert.deepEqual(parseCsv('a;b;c\n1;2;3'), [['a', 'b', 'c'], ['1', '2', '3']]);
  assert.deepEqual(parseCsv('a\tb\n1\t2'), [['a', 'b'], ['1', '2']]);
});

test('flexible header names map to the right fields', () => {
  const m = mapHeader(['User Name', 'Employee ID', 'E-mail Address', 'Office', 'Team']);
  assert.deepEqual(m, { username: 0, externalId: 1, email: 2, location: 3 });
  assert.equal(mapHeader(['userName', 'ID', 'email']).externalId, 1);
});

test('exported CSV neutralises formulas (CSV injection)', () => {
  const out = toCsv([['=HYPERLINK("x")', '+1', 'ok', 'a,b']]);
  assert.equal(out, `"'=HYPERLINK(""x"")",'+1,ok,"a,b"\r\n`);
});
