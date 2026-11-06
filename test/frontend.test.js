'use strict';
// Guards for mistakes in the page code that no API test can see.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const VIEWS = path.join(__dirname, '..', 'public', 'js', 'views');
const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8');

test('no table carries the .stack layout class', () => {
  // .stack is a flex column. On a <table> it turns off table layout, so the header
  // and the rows are sized separately and the columns stop lining up.
  assert.match(CSS, /^\.stack\s*\{[^}]*display:\s*flex/m, 'the layout class this guards against');
  for (const file of fs.readdirSync(VIEWS)) {
    const source = fs.readFileSync(path.join(VIEWS, file), 'utf8');
    assert.doesNotMatch(source, /<table[^>]*class="[^"]*\bstack\b/, `${file} puts .stack on a table`);
  }
  assert.doesNotMatch(CSS, /table\.stack/);
});

test('every table that turns into cards on a phone labels its cells for that', () => {
  for (const file of fs.readdirSync(VIEWS)) {
    const source = fs.readFileSync(path.join(VIEWS, file), 'utf8');
    if (source.includes('table-cards')) assert.match(source, /data-label=/, `${file} has card tables with no labels`);
  }
});
