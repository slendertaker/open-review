#!/usr/bin/env node
// check-tokens.js -- CSS custom-property consistency checker.
// Usage: node scripts/check-tokens.js [path/to/dashboard.css]
// Exits 0 when all var(--*) references in the CSS file resolve to defined tokens.
// Exits 1 and lists offending tokens otherwise.
// --color-fg and --color-error are FORBIDDEN: they are known-dead tokens that
// must never be referenced or aliased (repaired at point of use in Plan 04).

import { readFileSync } from 'fs';

const CSS_PATH = process.argv[2] ?? 'public/styles/dashboard.css';

// These tokens were never defined and must not appear anywhere as var() references.
// They are also never allowed in the defined set.
const FORBIDDEN = new Set(['--color-fg', '--color-error']);

let css;
try {
  css = readFileSync(CSS_PATH, 'utf8');
} catch (err) {
  console.error(`check-tokens: cannot read ${CSS_PATH}: ${err.message}`);
  process.exit(1);
}

// Extract defined custom properties: lines matching "--name:" (left of colon in a declaration).
// Match property names at the start of a declaration value pair.
const definedSet = new Set();
for (const m of css.matchAll(/--([a-zA-Z0-9_-]+)\s*:/g)) {
  definedSet.add(`--${m[1]}`);
}

// Extract referenced tokens: all var(--name) usages.
const referencedSet = new Set();
for (const m of css.matchAll(/var\(\s*(--[a-zA-Z0-9_-]+)/g)) {
  referencedSet.add(m[1]);
}

let failed = false;

// Check forbidden tokens in defined set (never alias them).
for (const token of FORBIDDEN) {
  if (definedSet.has(token)) {
    console.error(`check-tokens: FORBIDDEN token defined: ${token} (must never be aliased -- fix at point of use)`);
    failed = true;
  }
}

// Check forbidden tokens in referenced set.
for (const token of FORBIDDEN) {
  if (referencedSet.has(token)) {
    console.error(`check-tokens: FORBIDDEN token referenced: ${token} (dead token -- replace with --color-text-primary or --color-danger)`);
    failed = true;
  }
}

// Check every referenced token is defined.
const undefined_ = [];
for (const token of referencedSet) {
  if (FORBIDDEN.has(token)) continue; // already reported above
  if (!definedSet.has(token)) {
    undefined_.push(token);
  }
}

if (undefined_.length > 0) {
  console.error(`check-tokens: ${undefined_.length} undefined token(s) referenced in ${CSS_PATH}:`);
  for (const t of undefined_) {
    console.error(`  ${t}`);
  }
  failed = true;
}

if (failed) {
  process.exit(1);
}

console.log(`check-tokens: OK -- ${definedSet.size} tokens defined, ${referencedSet.size} references all resolve (${CSS_PATH})`);
process.exit(0);
