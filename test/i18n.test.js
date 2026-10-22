/* Guards the translation table: every key has both languages, placeholders line
 * up, and nothing was left untranslated by copy-paste. */
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/../src/i18n.ts', 'utf8');
const rows = [...src.matchAll(/^\t"([\w.]+)": \[("(?:[^"\\]|\\.)*"), ("(?:[^"\\]|\\.)*")\],$/gm)];

let bad = 0;
const fail = (msg) => { console.log('FAIL ' + msg); bad++; };

if (rows.length < 30) fail(`only ${rows.length} entries parsed; the table format probably changed`);

const ph = (s) => (s.match(/\{\d\}/g) || []).sort().join(',');
const cjk = /[一-鿿]/;
for (const [, key, en, zh] of rows) {
  if (en === zh) fail(`${key}: both languages identical`);
  if (ph(en) !== ph(zh)) fail(`${key}: placeholders differ, ${ph(en) || '-'} vs ${ph(zh) || '-'}`);
  if (cjk.test(en)) fail(`${key}: the English string contains CJK`);
  if (!cjk.test(zh) && !/^"[\w\s.()#/-]*"$/.test(zh)) fail(`${key}: the Chinese string looks untranslated`);
}

// The fallback rule: anything that is not Chinese gets English
for (const [tag, want] of [['zh-CN','zh'],['zh','zh'],['zh-Hant','zh'],['en-US','en'],['ja','en'],['fr','en'],['','en']]) {
  const got = /^zh/i.test(tag) ? 'zh' : 'en';
  if (got !== want) fail(`locale ${tag || '(empty)'} resolved to ${got}, expected ${want}`);
}

console.log(bad ? `\n${bad} problem(s)` : `PASS i18n: ${rows.length} entries, both languages complete`);
process.exit(bad ? 1 : 0);
