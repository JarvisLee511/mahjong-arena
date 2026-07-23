/* ============================================================
   Mahjong Arena — tile faces.
   Clean printed-style tileset from Wikimedia Commons (drawn by
   Cangjie6, public domain). Each file is a complete tile: white
   body + subtle border + bold coloured symbol, and the set
   INCLUDES proper illustrated flowers/seasons (春夏秋冬 梅蘭竹菊).
   Stored locally as assets/mjtiles/<code>.svg (code = m1..s9/z1..z7/f1..f8).
   ============================================================ */
(function (root) {
  'use strict';
  const A = 'assets/mjtiles/';
  const V = '?f=8';   // bump when tile art changes, to bust the browser cache
  function face(t) {
    return `<img class="tface-sym" src="${A}${t}.svg${V}" alt="" draggable="false">`;
  }
  const MJArt = { face };
  if (typeof module !== 'undefined' && module.exports) module.exports = MJArt;
  root.MJArt = MJArt;
})(typeof window !== 'undefined' ? window : globalThis);
