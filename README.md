# 該死的賭徒們 · Damn Gamblers 🀄

線上**台灣 16 張麻將** web app —— 開房給 6 位數房號、朋友加入即時對戰、空位自動 AI 補位;支援**換三張(美麻)**開局、託管、一圈/一將賽制與底注選擇。純前端 vanilla JS + Supabase Realtime,無需後端伺服器。

> Taiwanese 16-tile Mahjong in the browser. Create a room, share the 6-digit code, play in real time with friends (empty seats filled by AI). Vanilla JS + Supabase Realtime, fully static.

## 玩法
- **單機**:立即開打,三家 AI(easy / normal / hard,會看牌河防守)。
- **好友連線**:建立房間 → 分享房號 → 朋友加入;不足四人由 AI 補位。
- 規則:台式 16 張、吃碰槓、過水、嚴格平胡、單吊/嵌張/邊張/缺一門、大小三元四喜、天聽/地聽、七搶一/八仙過海、一炮多響/一炮一響可選。

## 技術
- 前端:HTML / CSS / vanilla JS(host 權威、per-seat 私牌視圖)。
- 連線:Supabase Realtime broadcast(免建表);`?local=1` 可用 BroadcastChannel 同瀏覽器多分頁測試。
- 引擎:144 張牌、胡牌判定、聽牌、台數計算,含壓力測試 `node test/stress.js`。

## 資源出處 / Credits
- **牌面**:Wikimedia Commons「SVG Planar illustrations of Mahjong tiles」平面牌組(對應與下載見 `assets/mjtiles/SOURCE.md`)。牌底為本專案 CSS 繪製。
- **背景音樂**:見 `assets/music/README`(Kevin MacLeod / PeriTune,CC-BY,已標註)。
- **台語語音**:`assets/audio/`。

各素材授權以其原始頁面為準,使用請遵循對應條款。
