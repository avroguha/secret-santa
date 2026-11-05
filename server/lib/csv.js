'use strict';
// RFC 4180 CSV with the usual real-world allowances: a UTF-8 BOM, CRLF or LF,
// quoted fields with "" escapes and embedded line breaks, and a delimiter
// guessed from the header line (comma, semicolon or tab - Excel in many
// locales saves with semicolons).

function detectDelimiter(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  let best = ',';
  let bestCount = -1;
  for (const d of [',', ';', '\t']) {
    let count = 0;
    let quoted = false;
    for (const ch of firstLine) {
      if (ch === '"') quoted = !quoted;
      else if (ch === d && !quoted) count += 1;
    }
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

function parseCsv(input) {
  const text = String(input || '').replace(/^﻿/, '');
  const delim = detectDelimiter(text);
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && field === '') {
      quoted = true;
      i += 1;
      continue;
    }
    if (ch === delim) {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  // drop blank lines
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

function toCsv(rows) {
  return `${rows
    .map((r) => r
      .map((v) => {
        let s = v === null || v === undefined ? '' : String(v);
        // A cell that starts like a formula is neutralised before it reaches
        // a spreadsheet (CSV injection).
        if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
        return /[",\r\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      })
      .join(','))
    .join('\r\n')}\r\n`;
}

module.exports = { parseCsv, toCsv, detectDelimiter };
