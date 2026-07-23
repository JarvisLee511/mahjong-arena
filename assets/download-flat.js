/* Download the flat "Planar" mahjong tile SVGs from Wikimedia Commons and
   save them under assets/mjtiles/<engine-code>.svg. */
const fs = require('fs');
const path = require('path');
const https = require('https');

const NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
const map = {};
for (let i = 1; i <= 9; i++) {
  map['m' + i] = `01${String(i).padStart(2, '0')}${NUM[i - 1]}萬`;
  map['p' + i] = `02${String(i).padStart(2, '0')}${NUM[i - 1]}餅`;
  map['s' + i] = `03${String(i).padStart(2, '0')}${NUM[i - 1]}條`;
}
map.z1 = '0401東風'; map.z2 = '0403南風'; map.z3 = '0402西風'; map.z4 = '0404北風';
map.z5 = '0405中';   map.z6 = '0406發';   map.z7 = '0407白';
map.f1 = '0501春'; map.f2 = '0502夏'; map.f3 = '0503秋'; map.f4 = '0504冬';
map.f5 = '0505梅'; map.f6 = '0506蘭'; map.f7 = '0507菊'; map.f8 = '0508竹';

const DIR = path.join(__dirname, 'mjtiles');
if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });

function get(url, cb, depth = 0, tries = 0) {
  https.get(url, {
    headers: {
      'User-Agent': 'MahjongArenaBot/1.0 (https://example.com; personal hobby project) node',
      'Accept': 'image/svg+xml,*/*',
    }
  }, (res) => {
    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && depth < 6) {
      res.resume();
      const loc = res.headers.location.startsWith('http')
        ? res.headers.location
        : 'https://commons.wikimedia.org' + res.headers.location;
      return get(loc, cb, depth + 1, tries);
    }
    if (res.statusCode === 429 && tries < 6) {
      res.resume();
      const wait = 1500 * (tries + 1);
      return setTimeout(() => get(url, cb, depth, tries + 1), wait);
    }
    if (res.statusCode !== 200) { cb(new Error('HTTP ' + res.statusCode + ' for ' + url)); res.resume(); return; }
    const chunks = [];
    res.on('data', (d) => chunks.push(d));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  }).on('error', cb);
}

const entries = Object.entries(map);
let done = 0, failed = 0;
function next(i) {
  if (i >= entries.length) {
    console.log(`\ndownloaded ${done}/${entries.length}, failed ${failed}`);
    return;
  }
  const [code, name] = entries[i];
  const url = 'https://commons.wikimedia.org/wiki/Special:FilePath/' + encodeURIComponent(name + '.svg');
  get(url, (err, buf) => {
    if (err || !buf || buf.length < 200 || !buf.toString('utf8', 0, 400).toLowerCase().includes('svg')) {
      console.error(`✗ ${code}  (${name})  ${err ? err.message : 'bad content ' + (buf && buf.length)}`);
      failed++;
    } else {
      fs.writeFileSync(path.join(DIR, code + '.svg'), buf);
      done++;
      process.stdout.write(`✓ ${code}=${name} (${buf.length}b)  `);
    }
    setTimeout(() => next(i + 1), 700);
  });
}
next(0);
