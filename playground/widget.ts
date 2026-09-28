// The bare playground page: a SINGLE-CHART workspace (topbar + chart, `layout: false`)
// with the Binance provider (public API, no key, no server needed), the page's own demo
// scripting engine, and an inline indicator manifest — the OSS integration surface
// exercised end to end.
//
// Vela SHIPS NO SCRIPTING ENGINE. `demo-engine.ts` (next to this file) is a ~300-line
// engine written against the public `ScriptingEngine` port purely so this page can
// exercise the indicator path with zero dependencies — it is the runnable companion to
// docs/contributing/adding-an-engine.md, not a product. For Pine Script, install the
// addon and swap one line:
//
//     npm i @luxalgo/vela-pinets pinets
//     import { PineWorkerEngine } from '@luxalgo/vela-pinets';
//     engines: { pine: () => new PineWorkerEngine() }
//
// …which is exactly what the addon's own playground does (repos/Vela-pinets, port 5192).
import { VelaWorkspace } from '../src/workspace';
import { BinanceProvider } from '../src/data/providers/binance';
import { BinomoForexProvider } from '../src/data/providers/binomo';
import { BiquoteProvider } from '../src/data/providers/biquote';
import { addSampleMarks } from './marks';
import { DemoEngine, DEMO_SCRIPTS } from './demo-engine';
import { PineEngine, PineWorkerEngine } from '@luxalgo/vela-pinets';
import { playgroundStorage } from './persistence';

// The playground's CUSTOM persistence (shared with the workspace page): with `persist`
// on, the shell saves and restores EVERYTHING through this adapter — prefs, renderer
// config, and user drawings. The key is pinned so this page never collides with the
// multi-chart page's own document ('vela-workspace') in the same adapter namespace.
const storage = playgroundStorage();

const urlParams = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
const initSymbol = urlParams?.get('symbol') ?? 'CRYPTO_IDX';
const initTf = urlParams?.get('tf') ?? urlParams?.get('timeframe') ?? '1';
const localTz = typeof window !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'Etc/UTC';

const ws = new VelaWorkspace('#chart', {
    layout: false, // SINGLE-CHART mode: one cell, no layout picker, no sync switches
    symbol: initSymbol,
    timeframe: initTf,
    timezone: localTz || 'Etc/UTC',
    live: true,
    animations: { liveBar: true },
    theme: 'dark',
    autofocus: true, // the chart IS the page — shortcuts work from the first keystroke
    persist: 'vela-widget', // → 'vela-play:vela-widget' in devtools (the page's historical key)
    storage,
    providers: {
        binomo: () => new BinomoForexProvider(),
        biquote: () => new BiquoteProvider(),
        binance: () => new BinanceProvider()
    },
    engines: {
        pine: () => {
            try {
                return new PineWorkerEngine();
            } catch {
                return new PineEngine();
            }
        },
        demo: () => new DemoEngine(),
    },
    defaultLanguage: 'pine', // scripts added without a `language` run on Pine Script
    indicators: [
        {
            name: '24H Next Candle Predictor [Anti-Chop Shield]',
            enabled: false,
            language: 'pine',
            category: 'Pine Script',
            script: `//@version=6
indicator("24H Next Candle Predictor [Anti-Chop Shield]", overlay=true, max_labels_count=500)

// ───────────── SETTINGS ─────────────
grp_core      = "Core Signal Settings"
minVotesTrend = input.int(4, "Min Score in Strong Trend (ADX > 20)", minval=3, maxval=10, group=grp_core)
minVotesRange = input.int(6, "Min Score in Ranging Market (ADX < 20)", minval=4, maxval=12, group=grp_core)
useHTFFilter  = input.bool(false, "Require HTF 200 EMA Trend Alignment", group=grp_core)
usePullbacks  = input.bool(true, "Enable EMA Pullback Signals", group=grp_core)

grp_antichop  = "Anti-Chop & Anti-Whipsaw Filters"
useChopIndex  = input.bool(true, "Block Signals on High Choppiness (CHOP > 55)", group=grp_antichop)
chopThreshold = input.float(55.0, "Max Allowed Choppiness Index", minval=40.0, maxval=70.0, group=grp_antichop)
useAtrFilter  = input.bool(true, "Require Volatility Expansion (ATR > SMA ATR)", group=grp_antichop)
useBodyFilter = input.bool(true, "Filter Out Small Bodies / Dojis (Min 35% Body)", group=grp_antichop)
useColorFlip  = input.bool(true, "Block Signals on Immediate Alternating Candles", group=grp_antichop)

grp_protect   = "Market Structure Safeguards"
blockAtSupport    = input.bool(true, "Block SHORT Signals Near Support Zone", group=grp_protect)
blockAtResistance = input.bool(false, "Block LONG Signals Near Resistance Zone", group=grp_protect)
useEngulfGuard    = input.bool(true, "Block Signals Against Opposite Engulfing", group=grp_protect)

grp_display   = "Display Options"
showSignals   = input.bool(true, "Show UP / DOWN predictions", group=grp_display)
showScores    = input.bool(true, "Show directional scores", group=grp_display)
showEMAs      = input.bool(true, "Show EMA trend lines", group=grp_display)
showLevels    = input.bool(true, "Show 24H support / resistance", group=grp_display)
showResults   = input.bool(true, "Show WIN / LOSS", group=grp_display)
showBoard     = input.bool(true, "Show accuracy dashboard", group=grp_display)

grp_params    = "Indicator Parameters"
fastLength    = input.int(9, "Fast EMA", minval=1, group=grp_params)
slowLength    = input.int(21, "Slow EMA", minval=2, group=grp_params)
adxLength     = input.int(14, "ADX Length", minval=2, group=grp_params)
rsiLength     = input.int(14, "RSI Length", minval=2, group=grp_params)

// ───────────── TIME & WINDOW ─────────────
secondsPerBar = timeframe.in_seconds()
bars24h = math.max(2, 
     math.min(3000, 
     int(math.ceil(86400.0 / secondsPerBar))))

enoughData = bar_index >= math.max(bars24h, 200)
validTF    = timeframe.isintraday and 
     secondsPerBar <= 3600 and 
     secondsPerBar >= 30 and 
     (86400.0 / secondsPerBar <= 3000)

high24    = ta.highest(high[1], bars24h)
low24     = ta.lowest(low[1], bars24h)

// ───────────── TECHNICAL INDICATORS ─────────────
emaFast  = ta.ema(close, fastLength)
emaSlow  = ta.ema(close, slowLength)
ema200   = ta.ema(close, 200)
rsiValue = ta.rsi(close, rsiLength)
atrValue = ta.atr(14)

// 1. Choppiness Index (14 Period)
chopVal = 100 * math.log10(ta.sma(ta.tr, 14) * 14 / (ta.highest(high, 14) - ta.lowest(low, 14))) / math.log10(14)
isNotChoppy = useChopIndex ? (chopVal < chopThreshold) : true

// 2. ATR Volatility Squeeze Filter
atrSma     = ta.sma(atrValue, 20)
isExpanding = useAtrFilter ? (atrValue >= atrSma) : true

// 3. Candle Body-to-Wick Ratio Filter
barRange   = high - low
bodySize   = math.abs(close - open)
validBody  = useBodyFilter ? (barRange > 0 and (bodySize / barRange) >= 0.35) : true

// 4. Anti-Whipsaw Direction Consistency
isBullCandle = close > open
isBearCandle = close < open

// ADX Trend Strength Calculation
[diPlus, diMinus, adxValue] = ta.dmi(adxLength, adxLength)
isTrending = adxValue >= 20.0

// Dynamic Minimum Votes based on Market Regime
dynamicMinVotes = isTrending ? minVotesTrend : minVotesRange

// OBV Volume Flow Confirmation
obvValue = ta.cum(ta.change(close) > 0 ? volume : ta.change(close) < 0 ? -volume : 0)
obvMa    = ta.sma(obvValue, 20)
obvBull  = obvValue > obvMa
obvBear  = obvValue < obvMa

// MACD
[macdLine, macdSignal, macdHist] = ta.macd(close, 12, 26, 9)

// Breakout Extensions
breakoutUp   = close > ta.highest(high[1], 20)
breakoutDown = close < ta.lowest(low[1], 20)

// ───────────── MARKET STRUCTURE GUARDS ─────────────
zoneBuffer   = atrValue * 0.75
atDemandZone = low <= (low24 + zoneBuffer)
atSupplyZone = high >= (high24 - zoneBuffer)

bullishEngulf = close > open and close[1] < open[1] and close >= open[1] and open <= close[1]
bearishEngulf = close < open and close[1] > open[1] and close <= open[1] and open >= close[1]

// ───────────── WEIGHTED VOTE ENGINE ─────────────
htfBullish = close > ema200
htfBearish = close < ema200

emaVote      = (emaFast > emaSlow and close > emaFast) ? 2 : (emaFast < emaSlow and close < emaFast) ? -2 : 0
macroVote    = htfBullish ? 1 : htfBearish ? -1 : 0
obvVote      = obvBull ? 1 : obvBear ? -1 : 0
breakoutVote = (bullishEngulf or breakoutUp) ? 2 : (bearishEngulf or breakoutDown) ? -2 : 0
rsiVote      = (rsiValue > 50) ? 1 : (rsiValue < 50) ? -1 : 0
macdVote     = (macdLine > macdSignal and macdHist > macdHist[1]) ? 1 : (macdLine < macdSignal and macdHist < macdHist[1]) ? -1 : 0

bullSR = (atDemandZone and close > open) or (close > high24 and close[1] <= high24)
bearSR = (atSupplyZone and close < open) or (close < low24 and close[1] >= low24)
srVote = (bullSR and not bearSR) ? 2 : (bearSR and not bullSR) ? -2 : 0

// Calculate Total Score
bullVotes = (emaVote > 0 ? emaVote : 0) + (macroVote > 0 ? macroVote : 0) + (obvVote > 0 ? obvVote : 0) + 
             (breakoutVote > 0 ? breakoutVote : 0) + (rsiVote > 0 ? rsiVote : 0) + (macdVote > 0 ? macdVote : 0) + (srVote > 0 ? srVote : 0)

bearVotes = (emaVote < 0 ? math.abs(emaVote) : 0) + (macroVote < 0 ? math.abs(macroVote) : 0) + (obvVote < 0 ? math.abs(obvVote) : 0) + 
             (breakoutVote < 0 ? math.abs(breakoutVote) : 0) + (rsiVote < 0 ? math.abs(rsiVote) : 0) + (macdVote < 0 ? math.abs(macdVote) : 0) + (srVote < 0 ? math.abs(srVote) : 0)

activeVotes = bullVotes + bearVotes
upScore   = activeVotes > 0 ? (100.0 * bullVotes / activeVotes) : 50.0
downScore = activeVotes > 0 ? (100.0 * bearVotes / activeVotes) : 50.0

// Pullback Re-entry
bullPullback = usePullbacks and emaFast > emaSlow and low <= emaFast and close > emaFast and isBullCandle
bearPullback = usePullbacks and emaFast < emaSlow and high >= emaFast and close < emaFast and isBearCandle

// ───────────── SIGNAL CONDITIONS & CHOP SHIELD ─────────────
ready = barstate.isconfirmed and enoughData and validTF

// Primary Signal Checks
rawPredictUp = ready and (
     (bullVotes >= dynamicMinVotes and bullVotes > bearVotes and (useHTFFilter ? htfBullish : true)) or 
     bullPullback
     )

rawPredictDown = ready and (
     (bearVotes >= dynamicMinVotes and bearVotes > bullVotes and (useHTFFilter ? htfBearish : true)) or 
     bearPullback
     )

// ANTI-CHOP & SAFEGUARD FILTERS
chopShieldPass = isNotChoppy and isExpanding and validBody

predictUp = rawPredictUp and chopShieldPass and
     (useColorFlip ? isBullCandle : true) and
     (not (blockAtResistance and atSupplyZone)) and 
     (not (useEngulfGuard and bearishEngulf))

predictDown = rawPredictDown and chopShieldPass and
     (useColorFlip ? isBearCandle : true) and
     (not (blockAtSupport and atDemandZone)) and 
     (not (useEngulfGuard and bullishEngulf))

prediction = predictUp ? 1 : predictDown ? -1 : 0

// ───────────── CURRENT-CANDLE SIGNALS ─────────────
plotshape(showSignals and predictUp, title="Next candle UP", style=shape.triangleup, location=location.belowbar, color=color.lime, size=size.small)
plotshape(showSignals and predictDown, title="Next candle DOWN", style=shape.triangledown, location=location.abovebar, color=color.red, size=size.small)

// UPDATED: NEXT UP Label styled identical to NEXT DOWN (Top-positioned pointing down)
if showSignals and showScores and predictUp
    label.new(bar_index, high + atrValue * 1.5, "NEXT UP\\n" + str.tostring(upScore, "#.0") + "%", style=label.style_label_down, color=color.rgb(0, 155, 65), textcolor=color.white, size=size.normal)

if showSignals and showScores and predictDown
    label.new(bar_index, high + atrValue * 1.5, "NEXT DOWN\\n" + str.tostring(downScore, "#.0") + "%", style=label.style_label_down, color=color.rgb(210, 40, 40), textcolor=color.white, size=size.normal)

// ───────────── HISTORICAL EVALUATION ─────────────
previousSignal = prediction[1]
nextUp   = close > open
nextDown = close < open

resolved = barstate.isconfirmed and previousSignal != 0 and close != open
won  = resolved and ((previousSignal == 1 and nextUp) or (previousSignal == -1 and nextDown))
lost = resolved and not won

wins   = ta.cum(won ? 1 : 0)
losses = ta.cum(lost ? 1 : 0)
total  = wins + losses
accuracy = total > 0 ? wins * 100.0 / total : na

if showResults and won
    label.new(x=bar_index - 1, y=low[1] - atrValue[1] * 0.8, text="✓ WIN", xloc=xloc.bar_index, yloc=yloc.price, style=label.style_label_up, color=color.rgb(0, 155, 65), textcolor=color.white, size=size.small)

if showResults and lost
    label.new(x=bar_index - 1, y=low[1] - atrValue[1] * 0.8, text="✕ LOSS", xloc=xloc.bar_index, yloc=yloc.price, style=label.style_label_up, color=color.rgb(210, 40, 40), textcolor=color.white, size=size.small)

// ───────────── CHART LEVELS ─────────────
plot(showEMAs ? emaFast : na, "Fast EMA", color=color.aqua)
plot(showEMAs ? emaSlow : na, "Slow EMA", color=color.orange)
plot(showEMAs ? ema200 : na, "200 HTF Trend EMA", color=color.white, linewidth=2)

plot(showLevels and validTF ? high24 : na, "24H Resistance", color=color.new(color.red, 55), style=plot.style_linebr)
plot(showLevels and validTF ? low24 : na, "24H Support", color=color.new(color.green, 55), style=plot.style_linebr)

// ───────────── DASHBOARD ─────────────
var table board = table.new(position.top_right, 2, 9, bgcolor=color.new(color.black, 15), border_width=1, border_color=color.gray)

if barstate.islast and showBoard
    latestDirection = prediction == 1 ? "NEXT UP" : prediction == -1 ? "NEXT DOWN" : "WAIT"
    latestColor     = prediction == 1 ? color.lime : prediction == -1 ? color.red : color.yellow

    table.cell(board, 0, 0, "24H PREDICTOR", text_color=color.white, bgcolor=color.navy)
    table.cell(board, 1, 0, validTF ? "ACTIVE" : "INVALID TF", text_color=validTF ? color.lime : color.red, bgcolor=color.navy)

    table.cell(board, 0, 1, "Market Regime", text_color=color.white)
    table.cell(board, 1, 1, isTrending ? "STRONG TREND" : "RANGE / CHOP", text_color=isTrending ? color.lime : color.orange)

    table.cell(board, 0, 2, "Chop Index", text_color=color.white)
    table.cell(board, 1, 2, str.tostring(chopVal, "#.0") + (isNotChoppy ? " (CLEAN)" : " (CHOPPY)"), text_color=isNotChoppy ? color.lime : color.red)

    table.cell(board, 0, 3, "Direction", text_color=color.white)
    table.cell(board, 1, 3, latestDirection, text_color=latestColor)

    table.cell(board, 0, 4, "Bull / Bear Points", text_color=color.white)
    table.cell(board, 1, 4, str.tostring(bullVotes) + " / " + str.tostring(bearVotes) + " (Req: " + str.tostring(dynamicMinVotes) + ")", text_color=color.white)

    table.cell(board, 0, 5, "UP / DOWN Score", text_color=color.white)
    table.cell(board, 1, 5, str.tostring(upScore, "#.0") + "% / " + str.tostring(downScore, "#.0") + "%", text_color=color.white)

    table.cell(board, 0, 6, "Wins / Losses", text_color=color.white)
    table.cell(board, 1, 6, str.tostring(wins, "#") + " / " + str.tostring(losses, "#"), text_color=color.white)

    table.cell(board, 0, 7, "Historical Accuracy", text_color=color.white)
    table.cell(board, 1, 7, na(accuracy) ? "N/A" : str.tostring(accuracy, "#.1") + "%", text_color=color.aqua)

    table.cell(board, 0, 8, "Evaluated Signals", text_color=color.white)
    table.cell(board, 1, 8, str.tostring(total, "#"), text_color=color.white)

// ───────────── ALERTS ─────────────
alertcondition(predictUp, "NEXT CANDLE UP", "24H Predictor: Anti-Chop UP signal on {{ticker}}.")
alertcondition(predictDown, "NEXT CANDLE DOWN", "24H Predictor: Anti-Chop DOWN signal on {{ticker}}.")`,
        },
        {
            name: 'EMA 20',
            enabled: false,
            language: 'pine',
            category: 'Pine Script',
            script: `//@version=5
indicator("EMA 20", overlay=true)
plot(ta.ema(close, 20), color=color.orange, linewidth=2)`,
        },
        {
            name: 'RSI 14',
            enabled: false,
            language: 'pine',
            category: 'Pine Script',
            script: `//@version=5
indicator("RSI 14", overlay=false)
plot(ta.rsi(close, 14), color=color.purple, linewidth=2)`,
        },
    ],

    // ── The rest of the CHART options, at their defaults — uncomment to play ─────────
    // bars: 1000,                     // history depth to load (paints progressively: newest window first)
    // settings: { hidden: ['advanced'] }, // hide settings-dialog entries by id — a tab ('advanced'), a
    //                                 //  group ('canvas.grid'), or a row; ids via chart.renderer.listSettingsIds()
    // data: myBars,                   // offline OHLCV[] — replaces the provider entirely (no fetches, no live)
    // visibleRange: '3M',             // initial window: '1D'|'1W'|'1M'|'3M'|'6M'|'1Y'|'5Y'|'YTD'|'ALL' or {from,to} in ms (default: frame the tail)
    // priceStyle: 'candles',          // 'candles'|'bars'|'line'|'area'|'baseline'|'heikinashi' or a registered chart-type id
    // volume: true,                   // the built-in volume columns (native indicator); false opts out
    // logScale: false,                // logarithmic price scale
    // currentPriceLine: true,         // dashed line + axis chip at the latest price
    // upColor: '#089981',             // bullish candles (default: the palette's bullish green)
    // downColor: '#f23645',           // bearish candles (default: the palette's bearish red)
    // glow: 0,                        // neon glow on line series, 0..~0.6 — WebGL2 backend only
    // animations: { zoom: true, pan: true, liveBar: false }, // eased zoom + inertial pan + forming-bar glide (true = 90 ms, or a duration in ms); false disables all
    // nativeBackend: 'auto',          // 'auto' = WebGL2 when available, else canvas2d; or force either
    // renderer: NativeRenderer,       // a custom IChartRenderer class (default: the native renderer)
    // drawings: true,                 // user drawings — default: toolbar VISIBLE; false removes the whole
    //                                 //  surface (the chart.drawings API stays); {tools/groups, toolbar} customizes
    // alertCap: 50,                   // alerts the topbar bell keeps (oldest drop beyond it)

    // ── The rest of the SHELL options, at their defaults ──────────────────────────────
    // indicators: [{ name: 'My script', script: DEMO_SCRIPTS.ema, language: 'demo' }], // a script
    //                                 //  manifest: rows the dialog lists next to the built-in catalog
    // indicators: async () => (await fetch('/my/manifest.json')).json(), // the manifest can also
    //                                 //  be an ASYNC LOADER (filesystem, authenticated API, …)
    // timeframes: ['1', '5', '15', '30', '60', '240', 'D', 'W', 'M'], // topbar timeframe presets
    // timezone: 'Etc/UTC',            // display timezone (IANA), switchable from the bottom bar
    // statusline: true,               // chrome: the status line
    // watermark: true,                // chrome: the symbol watermark behind the candles
    // bottombar: true,                // chrome: the range-presets + timezone bar
    // topbar: {                       // COMPOSE the topbar: each side lists its VISIBLE
    //     left: ['symbol', 'timeframes', 'style', 'layout', 'indicators', 'actions', 'undo-redo'],
    //     right: ['actions', 'alerts', 'panels', 'screenshot'],
    // },
    //                                 // These values ARE the defaults (an undeclared side keeps
    //                                 //  them; 'layout' simply never renders on this single-chart
    //                                 //  page). Entries render in LIST ORDER; omitting an id also
    //                                 //  removes its mobile entry and keyboard chord (mod+alt+S
    //                                 //  with 'screenshot', `/` with 'indicators'). 'actions' is
    //                                 //  the flow slot for contributed actions — naming an
    //                                 //  action's ID instead pins it at that spot. An explicit
    //                                 //  list is the side's complete (and frozen) contract.
});

void ws.chart.ready().then(() => console.log('[vela-dev] chart ready'));

// Sample timeline marks (chart.marks) — see marks.ts: a cluster, a fanning stack, a custom
// icon with details loaded on click… spread over the visible range once the chart painted.
void ws.chart.ready().then(() => addSampleMarks(ws.chart));

// The page shell follows the app theme — flip it from chart settings → Canvas → Theme
// (or `ws.setTheme('light')` in the console) and the body around the chart follows.
ws.chart.on('theme:changed', (t) => {
    document.body.style.background = t.background;
});

// Handy for poking around from the browser console.
(window as unknown as { ws: VelaWorkspace }).ws = ws;

// ── State surface demo (uncomment to try) ─────────────────────────────────────
// Single-chart mode speaks the SAME state triplet and document format as the grid —
// it is the single-cell case (layout '1', one `c1` cell). `persist` above writes
// exactly this document; the calls below are how a host composes custom flows
// (server snapshots, share links, templates) on top of it.
//
// // READ — one versioned document: market, prefs, renderer config, user drawings,
// // and the indicator ledger. JSON-safe: `JSON.stringify(snapshot)` is the payload.
// const snapshot = ws.getState();
// console.log('[state] document:', snapshot);
//
// // EVENT — fires debounced (~500ms) after ANY persistable change (draw a line,
// // switch the symbol, add an indicator…). Re-pull getState() for the fresh doc.
// // Returns an unsubscribe function.
// const offState = ws.on('state:changed', () => {
//     console.log('[state] changed →', ws.getState().charts[0]);
// });
//
// // WRITE — a same-shape document applies IN PLACE: the chart instance survives
// // (the market switches via setMarket), config/drawings/indicators are replaced.
// // Untrusted-safe: malformed fields are dropped by the shared codec, never thrown on.
// setTimeout(() => {
//     const doc = ws.getState();
//     doc.charts[0]!.symbol = 'SOLUSDT'; // retarget the chart…
//     doc.charts[0]!.drawings = { version: 1, drawings: [] }; // …and wipe its drawings
//     ws.applyState(doc);
//     offState();
// }, 5000);


// ── "Code" topbar entry — paste a script, Run it, injected on success (SDK showcase:
// contributed action + kit Dialog + chart.runIndicator; errors surface inline). ──
import { registerWidgetAction, registerIcon, type WidgetContext } from '../src/plugin';
import { Dialog } from '../src/ui';

registerIcon('code', '<svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="m5.5 4.5-4 3.5 4 3.5M10.5 4.5l4 3.5-4 3.5"/></svg>');

// Lazy UI singletons — DOM state only (the edited script survives reopen). The
// WidgetContext is NEVER stored: `run(ctx)` rebinds the Run button's handler on every
// invocation, so the ctx lives in that closure alone and always belongs to the
// invoking shell (the pattern that keeps working in a multi-chart grid).
const DEFAULT_PINE_SCRIPT = `//@version=5
indicator("Bollinger Bands", overlay=true)
length = input.int(20, minval=1)
src = input(close, title="Source")
mult = input.float(2.0, minval=0.001, maxval=50, title="StdDev")
basis = ta.sma(src, length)
dev = mult * ta.stdev(src, length)
upper = basis + dev
lower = basis - dev
plot(basis, "Basis", color=color.blue)
plot(upper, "Upper", color=color.gray)
plot(lower, "Lower", color=color.gray)`;

let codeDialog: Dialog | null = null;
let codeArea: HTMLTextAreaElement | null = null;
let codeStatus: HTMLElement | null = null;
let codeRun: HTMLButtonElement | null = null;

registerWidgetAction({
    id: 'dev.code',
    target: 'topbar',
    label: 'Code',
    icon: 'code',
    run: (ctx) => {
        if (!codeDialog) {
            codeArea = document.createElement('textarea');
            codeArea.value = DEFAULT_PINE_SCRIPT;
            codeArea.spellcheck = false;
            codeArea.style.cssText =
                'width:520px;max-width:80vw;height:220px;resize:vertical;background:var(--vela-surface-overlay);color:var(--vela-fg);border:1px solid var(--vela-border-soft);border-radius:var(--vela-radius-md);padding:10px;font:12px/1.5 ui-monospace,Consolas,monospace;outline:none;';
            codeRun = document.createElement('button');
            codeRun.textContent = 'Run';
            codeRun.style.cssText =
                'all:unset;margin-top:8px;padding:6px 18px;border-radius:var(--vela-radius-sm);background:var(--vela-accent);color:#0b0e14;font-weight:600;cursor:pointer;';
            codeStatus = document.createElement('div');
            codeStatus.style.cssText = 'margin-top:8px;min-height:1.3em;font-size:var(--vela-font-size-md);white-space:pre-wrap;';
            codeDialog = new Dialog({
                title: 'Run an indicator',
                host: ctx.host, // first invoker's root hosts the singleton (fine for the one-chart demo)
                closeOnInteractOutside: true,
                content: (body) => body.append(codeArea!, codeRun!, codeStatus!),
            });
        }
        // Rebind per invocation — `ctx` stays in this closure, no module-level context.
        codeRun!.onclick = () => void runCode(ctx);
        codeStatus!.textContent = '';
        codeDialog.show();
        setTimeout(() => codeArea?.focus(), 0);
    },
});

async function runCode(ctx: WidgetContext): Promise<void> {
    if (!codeArea || !codeStatus) return;
    codeStatus.style.color = 'var(--vela-fg-muted)';
    codeStatus.textContent = 'Running…';
    const r = await ctx.chart.runIndicator(codeArea.value);
    if (r.ok) {
        codeStatus.style.color = 'var(--vela-accent)';
        codeStatus.textContent = `✓ ${r.handle!.title || 'Indicator'} added to the chart`;
    } else {
        codeStatus.style.color = 'var(--vela-danger)';
        codeStatus.textContent = `✗ ${r.error!.message}`;
    }
}

ws.refreshActions();

// ── Execution-context listener demo — how host code intercepts Vela's engine context.
// 'context:changed' fires after the initial run and (throttled ~1/s) on live candles;
// pull a read-only snapshot and inspect it. Subscriptions survive symbol/timeframe
// changes — the shell switches markets IN PLACE (setMarket), same chart instance.
void ws.chart.ready().then(() => {
    const chart = ws.chart;
    chart.on('context:changed', ({ id }) => {
        void (async () => {
            const handle = chart.indicators().find((h) => h.id === id);
            const snap = await handle?.context(['plots', 'barIndex']);
            if (!handle || !snap) return;
            const keys = Object.keys(snap.plots);
            const points = Object.values(snap.plots).reduce((n, p) => n + p.length, 0);
            console.log(
                `[vela-ctx] ${handle.title || id} — ${keys.length} plot(s) [${keys.join(', ')}], ` +
                    `${points} points, last bar #${snap.barIndex} (${snap.phase})`,
            );
        })();
    });
});
