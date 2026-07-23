/* Remove the baked-in black tile OUTLINE from the flat Planar SVGs.
   The frame is the black, full-tile-span <path>; its element index (among
   path/rect/polygon in document order) was found by rendering each tile:
   index 0 for every tile except f1 (index 3). We give that element
   fill="none" so only the coloured symbol remains (the ivory face + edge is
   drawn by CSS). Symbols stay intact — incl. the black wind characters,
   which are smaller and never the full-span element. */
const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, 'mjtiles');

const FRAME_INDEX = {}; // default 0
['m', 'p', 's'].forEach((s) => { for (let i = 1; i <= 9; i++) FRAME_INDEX[s + i] = 0; });
for (let i = 1; i <= 7; i++) FRAME_INDEX['z' + i] = 0;
for (let i = 1; i <= 8; i++) FRAME_INDEX['f' + i] = 0;
FRAME_INDEX.f1 = 3;

let done = 0;
for (const code of Object.keys(FRAME_INDEX)) {
  const p = path.join(DIR, code + '.svg');
  if (!fs.existsSync(p)) { console.error('missing ' + code); continue; }
  let svg = fs.readFileSync(p, 'utf8');
  const target = FRAME_INDEX[code];
  let count = -1, hit = false;
  svg = svg.replace(/<(path|rect|polygon)\b/g, (m, tag) => {
    count++;
    if (count === target) { hit = true; return `<${tag} fill="none"`; }
    return m;
  });
  if (!hit) { console.error('frame index not reached for ' + code); continue; }
  fs.writeFileSync(p, svg);
  done++;
}
console.log('removed black frame from ' + done + ' tiles');
