'use strict';
const { html, raw } = require('./html');
const { fmt, fmtQty } = require('./money');

const ESTIMATE_STATUS = { draft: 'Draft', sent: 'Sent', approved: 'Approved', declined: 'Declined' };
const JOB_STATUS = { not_started: 'Not started', in_progress: 'In progress', completed: 'Completed' };
const ROLES = { admin: 'Admin', worker: 'Crew' };
// People show by name when they've given one, otherwise by email.
const who = (p) => (p && (p.full_name || p.name)) || (p && p.email) || '';
const initialOf = (p) => (who(p) || '?')[0].toUpperCase();

// ---------- Design system ----------
const CSS = `
:root{
  --bg:#f3f4f8;--surface:#ffffff;--surface-2:#f7f8fb;--text:#0f172a;--text-2:#475569;--text-3:#94a3b8;
  --line:#e6e8ef;--accent:#4f46e5;--accent-2:#6366f1;--accent-soft:#eef0ff;--on-accent:#ffffff;
  --green:#059669;--green-soft:#e7f7f0;--amber:#b45309;--amber-soft:#fdf3e2;--red:#dc2626;--red-soft:#fdecec;
  --blue:#2563eb;--blue-soft:#e8f0fe;--gray-soft:#eef1f5;
  --radius:16px;--radius-sm:12px;--shadow:0 1px 2px rgba(15,23,42,.04),0 4px 16px rgba(15,23,42,.06);
  --tabbar-h:64px;color-scheme:light;
}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){
  --bg:#0b0d14;--surface:#151823;--surface-2:#1b1f2c;--text:#eef1f7;--text-2:#a5adbf;--text-3:#6b7389;
  --line:#262b3a;--accent:#818cf8;--accent-2:#6366f1;--accent-soft:#232647;--on-accent:#0b0d14;
  --green:#34d399;--green-soft:#0f2a22;--amber:#fbbf24;--amber-soft:#2d2412;--red:#f87171;--red-soft:#321617;
  --blue:#60a5fa;--blue-soft:#14223a;--gray-soft:#20253a;--shadow:0 1px 2px rgba(0,0,0,.3);color-scheme:dark;
}}
:root[data-theme=dark]{
  --bg:#0b0d14;--surface:#151823;--surface-2:#1b1f2c;--text:#eef1f7;--text-2:#a5adbf;--text-3:#6b7389;
  --line:#262b3a;--accent:#818cf8;--accent-2:#6366f1;--accent-soft:#232647;--on-accent:#0b0d14;
  --green:#34d399;--green-soft:#0f2a22;--amber:#fbbf24;--amber-soft:#2d2412;--red:#f87171;--red-soft:#321617;
  --blue:#60a5fa;--blue-soft:#14223a;--gray-soft:#20253a;--shadow:0 1px 2px rgba(0,0,0,.3);color-scheme:dark;
}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.45 -apple-system,BlinkMacSystemFont,"SF Pro Text","Inter","Segoe UI",Roboto,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-decoration:none}
h2{font-size:13px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--text-2);margin:28px 4px 10px}
.svg{width:22px;height:22px;flex:none;stroke:currentColor;fill:none;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}
.svg.sm{width:18px;height:18px}

/* App shell */
.shell{min-height:100vh}
.sidebar{display:none}
.main{padding:0 16px calc(var(--tabbar-h) + 28px + env(safe-area-inset-bottom));max-width:760px;margin:0 auto}
.appbar{position:sticky;top:0;z-index:20;margin:0 -16px;padding:calc(env(safe-area-inset-top) + 10px) 16px 10px;
  background:color-mix(in srgb,var(--bg) 82%,transparent);backdrop-filter:saturate(180%) blur(16px);-webkit-backdrop-filter:saturate(180%) blur(16px)}
.appbar-row{display:flex;align-items:center;gap:10px;min-height:40px}
.appbar .back{display:inline-flex;align-items:center;gap:2px;color:var(--accent);font-weight:500;margin-left:-6px;padding:6px}
.appbar .back .svg{transform:rotate(180deg)}
.appbar-spacer{flex:1}
.page-title{font-size:30px;line-height:1.15;font-weight:750;letter-spacing:-.02em;margin:6px 2px 4px;overflow-wrap:anywhere}
.page-sub{color:var(--text-2);margin:0 2px 14px;font-size:15px}
.avatar{width:36px;height:36px;border-radius:50%;display:grid;place-items:center;background:var(--accent-soft);color:var(--accent);font-weight:700;font-size:15px}
.tabbar{position:fixed;left:0;right:0;bottom:0;z-index:30;display:flex;justify-content:space-around;
  padding:6px 6px calc(6px + env(safe-area-inset-bottom));min-height:var(--tabbar-h);
  background:color-mix(in srgb,var(--surface) 86%,transparent);backdrop-filter:saturate(180%) blur(18px);-webkit-backdrop-filter:saturate(180%) blur(18px);border-top:1px solid var(--line)}
.tabbar a{flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;padding:6px 0;color:var(--text-3);font-size:11px;font-weight:600;border-radius:12px}
.tabbar a.on{color:var(--accent)}
@media (min-width:960px){
  .tabbar{display:none}
  .sidebar{display:flex;flex-direction:column;gap:4px;position:fixed;top:0;bottom:0;left:0;width:248px;padding:22px 14px;background:var(--surface);border-right:1px solid var(--line)}
  .sidebar .brand{display:flex;align-items:center;gap:10px;font-weight:750;font-size:17px;padding:4px 10px 18px;color:var(--text)}
  .sidebar a.nav{display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:12px;color:var(--text-2);font-weight:550}
  .sidebar a.nav:hover{background:var(--surface-2)}
  .sidebar a.nav.on{background:var(--accent-soft);color:var(--accent)}
  .sidebar .grow{flex:1}
  .sidebar .who{display:flex;align-items:center;gap:10px;padding:10px;border-radius:12px;color:var(--text);font-size:14px}
  .sidebar .who small{display:block;color:var(--text-3)}
  .main{margin-left:248px;margin-right:0;max-width:none;padding:0 40px 48px}
  .main>.content{max-width:820px}
  .appbar{margin:0 -40px;padding:16px 40px 10px}
  .appbar .avatar{display:none}
  .fab{bottom:32px!important}
}
.mark{width:34px;height:34px;border-radius:10px;display:grid;place-items:center;color:#fff;font-weight:800;font-size:14px;letter-spacing:-.02em;
  background:linear-gradient(135deg,#4f46e5,#7c3aed 60%,#db2777)}
.mark.lg{width:64px;height:64px;border-radius:18px;font-size:24px;margin:0 auto 14px;box-shadow:0 10px 30px rgba(79,70,229,.35)}
.mark svg{width:100%;height:100%;display:block}

/* Segmented control */
.seg{display:flex;gap:4px;padding:4px;margin-top:12px;border-radius:12px;background:var(--surface-2);border:1px solid var(--line)}
.seg button{flex:1;min-height:40px;border:0;border-radius:9px;background:transparent;color:var(--text-2);font-weight:600;box-shadow:none}
.seg button.on{background:var(--surface);color:var(--text);box-shadow:var(--shadow)}
.seg label{flex:1;min-height:40px;display:grid;place-items:center;margin:0;border-radius:9px;color:var(--text-2);font-weight:600}.seg label.on{background:var(--surface);color:var(--text);box-shadow:var(--shadow)}

/* Surfaces */
.card{background:var(--surface);border-radius:var(--radius);box-shadow:var(--shadow);padding:18px;margin-bottom:14px}
.card.flush{padding:0;overflow:hidden}
.hero{border-radius:22px;padding:20px;color:#fff;margin:6px 0 14px;background:linear-gradient(135deg,#4338ca 0%,#6d28d9 55%,#be185d 120%);box-shadow:0 12px 30px rgba(79,70,229,.28)}
.hero-top{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}.hero-top .delta{margin-top:0}
.hero .k{font-size:14px;opacity:.85;font-weight:500}
.hero .v{font-size:38px;font-weight:780;letter-spacing:-.03em;margin:4px 0 2px;font-variant-numeric:tabular-nums}
.hero .s{font-size:13px;opacity:.8}
.stats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-bottom:14px}
@media (min-width:640px){.stats.three{grid-template-columns:repeat(3,minmax(0,1fr))}.stats.four{grid-template-columns:repeat(4,minmax(0,1fr))}}
.stat{background:var(--surface);border-radius:var(--radius);box-shadow:var(--shadow);padding:14px 16px;min-width:0}
.stat .k{font-size:13px;color:var(--text-2);font-weight:500}
.stat .v{font-size:22px;font-weight:720;letter-spacing:-.02em;margin-top:2px;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.stat .s{font-size:12px;color:var(--text-3);margin-top:2px}
.stat.wide{grid-column:1/-1}
@media (max-width:639px){.stat.wide-sm{grid-column:1/-1}}
.stat.good .v{color:var(--green)} .stat.bad .v{color:var(--red)}

/* Lists */
.list{background:var(--surface);border-radius:var(--radius);box-shadow:var(--shadow);overflow:hidden;margin-bottom:14px}
.li{display:flex;align-items:center;gap:12px;padding:14px 16px;color:var(--text);min-height:60px;position:relative}
.li+.li::before{content:"";position:absolute;top:0;left:16px;right:0;border-top:1px solid var(--line)}
a.li:active{background:var(--surface-2)}
@media (hover:hover){a.li:hover{background:var(--surface-2)}}
.li .main-t{flex:1;min-width:0}
.li .t{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.li .s{font-size:14px;color:var(--text-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.li .r{text-align:right;flex:none;display:flex;flex-direction:column;align-items:flex-end;gap:4px}
.li .amt{font-weight:650;font-variant-numeric:tabular-nums}
.li .chev{color:var(--text-3)}
.li .icon-bubble{width:40px;height:40px;border-radius:12px;display:grid;place-items:center;flex:none;background:var(--accent-soft);color:var(--accent)}
.empty{text-align:center;color:var(--text-2);padding:28px 16px;background:var(--surface);border-radius:var(--radius);box-shadow:var(--shadow);margin-bottom:14px}
.kv{display:flex;gap:12px;padding:12px 16px;align-items:flex-start}
.kv+.kv{border-top:1px solid var(--line)}
.kv .k{width:118px;flex:none;color:var(--text-2);font-size:14px;padding-top:1px}
.kv .v{flex:1;min-width:0;overflow-wrap:anywhere}
.pre{white-space:pre-wrap}

/* Pills & chips */
.pill{display:inline-flex;align-items:center;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:650;background:var(--gray-soft);color:var(--text-2);white-space:nowrap}
.pill.approved,.pill.completed{background:var(--green-soft);color:var(--green)}
.pill.sent,.pill.in_progress{background:var(--blue-soft);color:var(--blue)}
.pill.declined{background:var(--red-soft);color:var(--red)}
.pill.draft,.pill.not_started{background:var(--amber-soft);color:var(--amber)}
.chips{display:flex;gap:8px;overflow-x:auto;padding:2px 2px 12px;margin:0 -16px;padding-left:16px;padding-right:16px;scrollbar-width:none}
.chips::-webkit-scrollbar{display:none}
.chip{flex:none;padding:8px 14px;border-radius:999px;background:var(--surface);box-shadow:var(--shadow);color:var(--text-2);font-weight:600;font-size:14px}
.chip.on{background:var(--text);color:var(--bg)}

/* Buttons */
.btn,button{-webkit-appearance:none;appearance:none;font:inherit;font-weight:620;display:inline-flex;align-items:center;justify-content:center;gap:8px;
  min-height:48px;padding:0 18px;border-radius:14px;border:0;white-space:nowrap;background:var(--accent);color:var(--on-accent);cursor:pointer;text-align:center;transition:transform .08s,opacity .15s}
.btn:active,button:active{transform:scale(.98)}
.btn.secondary,button.secondary{background:var(--accent-soft);color:var(--accent)}
.btn.ghost,button.ghost{background:transparent;color:var(--accent);padding:0 10px}
.btn.danger,button.danger{background:var(--red-soft);color:var(--red)}
.btn.danger.solid,button.danger.solid{background:var(--red);color:#fff}
.btn.sm,button.sm{min-height:36px;padding:0 14px;border-radius:10px;font-size:14px}
.btn.block,button.block{width:100%}
button:disabled{opacity:.55;cursor:default}
button.link{background:none;min-height:0;padding:0;color:var(--accent);font-weight:600}
.actions{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:14px}
.fab{position:fixed;right:18px;bottom:calc(var(--tabbar-h) + 18px + env(safe-area-inset-bottom));z-index:25;height:56px;padding:0 20px 0 16px;border-radius:18px;
  background:var(--accent);color:var(--on-accent);display:inline-flex;align-items:center;gap:8px;font-weight:650;box-shadow:0 10px 24px rgba(79,70,229,.4)}
.row{display:flex;flex-wrap:wrap;gap:10px;align-items:center}

/* Forms */
.form-card{background:var(--surface);border-radius:var(--radius);box-shadow:var(--shadow);padding:6px 16px 16px;margin-bottom:14px}
.form-card h3{font-size:17px;margin:14px 0 2px}
label{display:block;font-size:13px;font-weight:600;color:var(--text-2);margin:14px 2px 6px}
input,select,textarea{font:inherit;font-size:16px;width:100%;min-height:48px;padding:12px 14px;border-radius:12px;border:1.5px solid var(--line);background:var(--surface-2);color:var(--text);outline:none;transition:border-color .15s,box-shadow .15s}
textarea{min-height:110px;resize:vertical}
select{background-image:linear-gradient(45deg,transparent 50%,var(--text-3) 50%),linear-gradient(135deg,var(--text-3) 50%,transparent 50%);
  background-position:calc(100% - 20px) 50%,calc(100% - 14px) 50%;background-size:6px 6px;background-repeat:no-repeat;-webkit-appearance:none;appearance:none;padding-right:36px}
input:focus,select:focus,textarea:focus{border-color:var(--accent);box-shadow:0 0 0 4px var(--accent-soft);background:var(--surface)}
input.invalid,select.invalid,textarea.invalid{border-color:var(--red)}
.field-error{color:var(--red);font-size:13px;margin:6px 2px 0}
.hint{color:var(--text-3);font-size:13px;margin:6px 2px 0}
.two{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:0 12px}
.two>div{min-width:0}
.two>div{min-width:0}
input[type=date],input[type=time]{min-width:0;max-width:100%;-webkit-appearance:none;appearance:none;display:block}
@media (max-width:520px){.two.stack{grid-template-columns:1fr}}
.form-actions{display:flex;gap:10px;margin:18px 0}
.form-actions>*{flex:1}
.search{position:relative;margin:4px 0 14px}
.search .svg{position:absolute;left:14px;top:50%;transform:translateY(-50%);color:var(--text-3)}
.search input{padding-left:44px;background:var(--surface);border-color:transparent;box-shadow:var(--shadow)}

/* Line items */
.item{background:var(--surface-2);border-radius:14px;padding:12px;margin-top:10px}
.item .grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px}
.item input,.item textarea{background:var(--surface)}
.item textarea.item-details{margin-top:8px;min-height:96px;resize:vertical;line-height:1.45}
.li-details{white-space:pre-wrap;color:var(--text-2);font-size:14px;margin-top:4px;line-height:1.45}
.item .foot{display:flex;justify-content:space-between;align-items:center;margin-top:10px;font-size:14px;color:var(--text-2)}
.item .line-total{font-weight:650;color:var(--text);font-variant-numeric:tabular-nums}
.totalbar{position:sticky;bottom:calc(var(--tabbar-h) + env(safe-area-inset-bottom) + 8px);z-index:10;display:flex;align-items:center;gap:8px;
  background:color-mix(in srgb,var(--surface) 92%,transparent);backdrop-filter:saturate(180%) blur(16px);-webkit-backdrop-filter:saturate(180%) blur(16px);
  color:var(--text);border:1px solid var(--line);border-radius:18px;padding:10px 10px 10px 16px;margin:14px 0;box-shadow:0 10px 30px rgba(15,23,42,.14)}
@media (min-width:960px){.totalbar{bottom:16px}}
.totalbar .lbl{font-size:12px;color:var(--text-2)}
.totalbar .num{font-size:20px;font-weight:750;font-variant-numeric:tabular-nums;color:var(--accent)}
.totalbar .grow{flex:1;min-width:0}
.totalbar .btn.ghost{color:var(--text-2);padding:0 8px}

/* Growth badge */
.chart{background:var(--surface);border-radius:var(--radius);box-shadow:var(--shadow);padding:14px 14px 10px;margin:14px 0}
.chart-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:10px}
.chart-head h2{margin:0;font-size:16px}
.chart-read{text-align:right;line-height:1.2}.chart-read strong{display:block;font-size:17px;font-variant-numeric:tabular-nums}.chart-read span{font-size:12px;color:var(--text-3)}
.chart-plot{position:relative;padding-left:40px}
.chart-max,.chart-mid{position:absolute;left:0;font-size:11px;color:var(--text-3);font-variant-numeric:tabular-nums;transform:translateY(-50%)}
.chart-max{top:0}.chart-mid{top:70px}
.bars{display:flex;align-items:stretch;gap:2px;height:161px;background:linear-gradient(var(--line),var(--line)) 0 0/100% 1px no-repeat,linear-gradient(var(--line),var(--line)) 0 70px/100% 1px no-repeat}
.bar-col{flex:1;min-width:0;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:0;padding:0;border:0;background:transparent;box-shadow:none;min-height:0;cursor:pointer;color:var(--text-3)}
.bar-col .bar{display:block;width:100%;max-width:28px;border-radius:4px 4px 0 0;background:var(--accent);opacity:.45;transition:opacity .15s}
.bar-area{flex:1;width:100%;display:flex;align-items:flex-end;justify-content:center}
.bar-col.on .bar,.bar-col:hover .bar{opacity:1}.bar-col.on .bar-l{color:var(--text);font-weight:700}
.bar-l{font-size:11px;height:14px;line-height:14px;white-space:nowrap;border-top:1px solid var(--line);width:100%;text-align:center;padding-top:6px;box-sizing:content-box}
.photos{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}
.photo{position:relative;aspect-ratio:1;border-radius:12px;overflow:hidden;background:var(--surface-2)}
.photo img{width:100%;height:100%;object-fit:cover;display:block}
.photo form{position:absolute;top:4px;right:4px;margin:0}
.photo-del{width:28px;height:28px;min-height:0;padding:0;border-radius:50%;background:rgba(0,0,0,.55);color:#fff;font-size:18px;line-height:1;box-shadow:none}
.photo-add{cursor:pointer}
.billed{margin:6px 0 14px}.billed-bar{display:flex;height:10px;border-radius:999px;background:var(--surface-2);border:1px solid var(--line);overflow:hidden}
.billed-bar .paid,.billed-k i.paid{background:var(--green)}.billed-bar .sent,.billed-k i.sent{background:var(--accent);opacity:.55}
.billed-k{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:12px;color:var(--text-2);margin-top:6px}
.billed-k i{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px}
.progress-presets{margin:4px 0 10px;padding:0;flex-wrap:wrap}.progress-presets .chip{min-height:36px;padding:6px 14px;box-shadow:none;background:var(--surface-2);color:var(--text);border:1px solid var(--line)}.progress-presets .chip.on{background:var(--accent);color:var(--on-accent)}
.clock{display:flex;align-items:center;justify-content:space-between;gap:12px}
.clock .t{font-weight:700}.clock .s{font-size:13px;color:var(--text-2)}
.landing{max-width:1040px;margin:0 auto;padding:calc(env(safe-area-inset-top) + 12px) 16px 40px}
.lp-top{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 0 24px}
.lp-brand{display:flex;align-items:center;gap:10px;font-weight:800;font-size:20px;color:var(--text);text-decoration:none}
.lp-top nav{display:flex;align-items:center;gap:14px}
.lp-hero{text-align:center;max-width:720px;margin:24px auto 36px}.lp-hero h1{font-size:clamp(30px,6vw,48px);letter-spacing:-.03em;line-height:1.1;margin:0 0 14px}
.lp-hero p{color:var(--text-2);font-size:18px;line-height:1.5}.lp-cta{display:flex;gap:12px;justify-content:center;flex-wrap:wrap;margin:22px 0 8px}
.lp-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px}.lp-grid .card h3{margin:10px 0 6px}.lp-grid .card p{margin:0;color:var(--text-2);line-height:1.5}
.lp-pricing{margin-top:40px;text-align:center}.lp-pricing .card{text-align:left}.lp-price{font-size:30px;font-weight:800;margin:4px 0 8px}.lp-price span{font-size:15px;font-weight:500;color:var(--text-2)}
.lp-foot{text-align:center;margin-top:40px}.footer-links{margin-top:28px}.footer-links a{white-space:nowrap}
.legal{max-width:720px;margin:0 auto;padding:24px 4px 48px;line-height:1.6}.legal h1{margin:12px 0 4px}.legal h2{margin-top:26px}.legal ul{padding-left:20px}.legal li{margin:6px 0}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.delta{display:inline-flex;align-items:center;gap:4px;padding:3px 9px;border-radius:999px;font-size:13px;font-weight:700;background:rgba(255,255,255,.2);color:#fff;margin-top:8px}
.stat .delta{background:var(--gray-soft);color:var(--text-2);margin-top:6px;font-size:12px}
.stat .delta.up{background:var(--green-soft);color:var(--green)} .stat .delta.down{background:var(--red-soft);color:var(--red)}

/* Calendar */
.cal{background:var(--surface);border-radius:var(--radius);box-shadow:var(--shadow);padding:12px 10px 10px;margin-bottom:14px}
.cal-head{display:flex;align-items:center;justify-content:space-between;padding:2px 6px 10px}
.cal-head strong{font-size:17px}
.cal-head a{width:36px;height:36px;border-radius:10px;display:grid;place-items:center;background:var(--surface-2);color:var(--text)}
.cal-head a.prev .svg{transform:rotate(180deg)}
.cal-head .today-link{width:auto;padding:0 12px;font-size:14px;font-weight:600;color:var(--accent)}
.cal-grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:2px;text-align:center}
.cal-dow{font-size:11px;font-weight:700;color:var(--text-3);padding:4px 0 6px;text-transform:uppercase;letter-spacing:.04em}
.cal-day{display:flex;flex-direction:column;align-items:center;gap:3px;padding:6px 0 7px;border-radius:12px;color:var(--text);min-height:50px}
.cal-day.out{color:var(--text-3);opacity:.55}
.cal-day .n{width:32px;height:32px;line-height:32px;border-radius:50%;font-weight:600;font-size:15px;font-variant-numeric:tabular-nums}
.cal-day.today .n{color:var(--accent);box-shadow:inset 0 0 0 1.5px var(--accent)}
.cal-day.sel .n{background:var(--accent);color:var(--on-accent);box-shadow:none}
.cal-dots{display:flex;gap:3px;height:6px}
.cal-dots i{width:6px;height:6px;border-radius:50%;background:var(--amber)}
.cal-dots i.in_progress{background:var(--blue)} .cal-dots i.completed{background:var(--green)} .cal-dots i.visit{background:transparent;box-shadow:inset 0 0 0 1.6px var(--accent)}
.cal-legend{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:var(--text-2);margin:-4px 4px 4px}
.cal-legend i{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:5px;vertical-align:1px}
@media (hover:hover){a.cal-day:hover{background:var(--surface-2)}}
.view-switch{margin:0 0 12px}
.seg a{flex:1;min-height:36px;border-radius:9px;display:grid;place-items:center;color:var(--text-2);font-weight:600;font-size:14px}
.seg a.on{background:var(--surface);color:var(--text);box-shadow:var(--shadow)}
.wk-day{display:flex;gap:12px;padding:10px 6px;border-top:1px solid var(--line)}
.wk-day:first-of-type{border-top:0}
.wk-date{width:44px;flex:none;text-align:center;color:var(--text-2)}
.wk-date span{display:block;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em}
.wk-date strong{display:block;font-size:20px;color:var(--text);font-variant-numeric:tabular-nums}
.wk-day.today .wk-date strong{color:var(--accent)}
.wk-items{flex:1;min-width:0;display:flex;flex-direction:column;gap:6px;justify-content:center}
.wk-item{display:block;padding:7px 10px;border-radius:10px;background:var(--surface-2);color:var(--text);font-weight:600;font-size:14px;border-left:4px solid var(--amber);min-width:0}
.wk-item small{display:block;font-weight:400;color:var(--text-2);font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wk-item.in_progress{border-left-color:var(--blue)} .wk-item.completed{border-left-color:var(--green)}
.wk-item.visit{border-left-color:var(--accent);background:var(--accent-soft)}
.wk-none{color:var(--text-3);font-size:14px;padding:8px 0}
table.lines{width:100%;border-collapse:collapse}
table.lines td,table.lines th{padding:12px 16px;text-align:left;font-size:15px}
table.lines th{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--text-3);font-weight:600}
table.lines tr+tr td{border-top:1px solid var(--line)}
table.lines .num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
table.lines tfoot td{border-top:1px solid var(--line);font-weight:750;font-size:17px}

/* Feedback */
.toast{position:fixed;left:50%;top:calc(env(safe-area-inset-top) + 12px);transform:translateX(-50%);z-index:50;background:var(--text);color:var(--bg);
  padding:12px 18px;border-radius:14px;font-weight:600;font-size:15px;box-shadow:0 10px 30px rgba(15,23,42,.25);display:flex;gap:8px;align-items:center;
  animation:toast 3.4s ease forwards;max-width:calc(100% - 32px)}
@keyframes toast{0%{opacity:0;transform:translate(-50%,-12px)}8%{opacity:1;transform:translate(-50%,0)}85%{opacity:1}100%{opacity:0;visibility:hidden}}
.errors{background:var(--red-soft);color:var(--red);border-radius:var(--radius);padding:14px 16px;margin-bottom:14px;font-size:15px}
.errors ul{margin:6px 0 0;padding-left:18px}
.notice{background:var(--amber-soft);color:var(--amber);border-radius:var(--radius);padding:14px 16px;margin-bottom:14px;font-size:15px}
.notice a{color:inherit;text-decoration:underline}
.muted{color:var(--text-2)}
.sig-img{display:block;max-width:100%;height:90px;margin-top:12px;background:#fff;border-radius:10px;border:1px solid var(--line)}
.sig-typed{margin-top:12px;font:italic 30px/1.2 "Snell Roundhand","Segoe Script","Brush Script MT",cursive}
.track{font-size:14px;color:var(--text-2);background:var(--surface-2);border-radius:10px;padding:10px 12px;margin-bottom:12px}
table.lines tr.grp td{background:var(--surface-2);font-weight:600;font-size:14px;color:var(--text-2)}
table.lines tbody.not-chosen{opacity:.45}
.pub{max-width:640px;margin:0 auto;padding:calc(env(safe-area-inset-top) + 20px) 16px 40px}
.pub-head{display:flex;align-items:center;gap:14px;margin:4px 2px 18px}
.pub-logo{max-width:150px;max-height:60px;object-fit:contain}
.pub-co{font-weight:700;font-size:18px}
.pub-title{font-size:26px;line-height:1.2;letter-spacing:-.02em;margin:4px 0 6px}
.pub-ok{border:2px solid var(--green)}
.pub-foot{text-align:center;color:var(--text-3);font-size:13px;margin-top:24px}
.opts{display:grid;gap:12px;margin-bottom:14px}
@media(min-width:640px){.opts{grid-template-columns:repeat(auto-fit,minmax(180px,1fr))}}
.opt{display:block;background:var(--surface);border-radius:var(--radius);box-shadow:var(--shadow);padding:16px;border:2px solid transparent;cursor:pointer;position:relative;margin:0;font-weight:400}
.opt.on{border-color:var(--accent);background:var(--accent-soft)}.opt.dim{opacity:.5}
.opt input[type=radio]{position:absolute;top:18px;right:16px;width:20px;height:20px;accent-color:var(--accent)}
.opt-head{display:flex;flex-direction:column;gap:2px;padding-right:28px}.opt-head strong{font-size:17px}
.opt-total{font-size:24px;font-weight:750;letter-spacing:-.02em}
.opt ul{margin:8px 0 6px;padding-left:18px;font-size:15px}.opt li{margin:3px 0}
.sigpad{position:relative;background:#fff;border:1.5px dashed var(--line);border-radius:12px;margin-bottom:6px}
.sigpad canvas{display:block;width:100%;height:auto;aspect-ratio:10/3;touch-action:none;cursor:crosshair}
.sigpad .link{position:absolute;right:10px;bottom:6px;font-size:14px}
label.check{display:flex;gap:10px;align-items:flex-start;font-weight:500;margin-top:14px}
label.check input{width:20px;height:20px;flex:none;margin-top:2px;accent-color:var(--accent)}
details.decline{margin:16px 2px}details.decline summary{color:var(--text-2);cursor:pointer;font-size:15px}
.opt-input{margin-top:8px;font-size:15px !important;padding:9px 12px !important}
.plan-strip{display:flex;align-items:center;gap:12px;color:inherit;text-decoration:none;padding:14px 16px}
.plan-strip .main-t{flex:1;min-width:0}.plan-strip .t{font-weight:600}.plan-strip .s{color:var(--text-2);font-size:14px}
.seg{display:flex;background:var(--surface-2);border-radius:12px;padding:4px;margin:6px 0 14px}
.seg a{flex:1;text-align:center;padding:9px 10px;border-radius:9px;color:var(--text-2);font-weight:600;text-decoration:none;font-size:15px}
.seg a.on{background:var(--surface);color:var(--text);box-shadow:var(--shadow)}
.pay-type label{flex:1;text-align:center;padding:9px 6px;border-radius:9px;color:var(--text-2);font-weight:600;font-size:15px;margin:0;cursor:pointer}
.pay-type label.on{background:var(--surface);color:var(--text);box-shadow:var(--shadow)}.pay-type input{position:absolute;opacity:0;pointer-events:none}
.seg .save{color:var(--green);font-size:12px;margin-left:4px}
.plans{display:grid;gap:14px;grid-template-columns:1fr;margin-bottom:14px}
@media(min-width:900px){.plans{grid-template-columns:repeat(3,1fr)}}
.plan{background:var(--surface);border-radius:var(--radius);box-shadow:var(--shadow);padding:20px;display:flex;flex-direction:column;border:2px solid transparent}
.plan.featured{border-color:var(--accent)}.plan.current{border-color:var(--green)}
.plan-head{display:flex;justify-content:space-between;align-items:center}.plan h3{margin:0;font-size:18px}
.plan .price{font-size:34px;font-weight:750;letter-spacing:-.03em;margin-top:8px}.plan .price small{font-size:15px;color:var(--text-2);font-weight:500}
.plan .price-note{color:var(--text-2);font-size:13px;min-height:18px}
.plan p{margin:10px 0 6px;font-size:14px}
.feat{list-style:none;padding:0;margin:0 0 16px;flex:1}.feat li{padding:5px 0 5px 24px;position:relative;font-size:15px}
.feat li:before{content:"";position:absolute;left:3px;top:10px;width:10px;height:6px;border-left:2px solid var(--green);border-bottom:2px solid var(--green);transform:rotate(-45deg)}
.code{font:700 30px/1.1 ui-monospace,"SF Mono",Menlo,monospace;letter-spacing:.12em;text-align:center;padding:18px;border-radius:14px;background:var(--surface-2);margin:10px 0;user-select:all}

/* Auth */
.auth{min-height:100vh;display:flex;flex-direction:column;justify-content:center;padding:calc(env(safe-area-inset-top) + 24px) 20px 32px;max-width:420px;margin:0 auto}
.auth h1{text-align:center;font-size:28px;letter-spacing:-.02em;margin:0 0 6px}
.auth .sub{text-align:center;color:var(--text-2);margin:0 0 22px}
.auth .alt{text-align:center;color:var(--text-2);margin-top:18px;font-size:15px}
`;

// Small shared behaviours. Keep this free of the dollar sign: worker pages are checked for it.
const JS = `
document.addEventListener('submit', function (e) {
  var f = e.target;
  if (f.dataset.confirm && !confirm(f.dataset.confirm)) { e.preventDefault(); return; }
  if (f.dataset.submitted) { e.preventDefault(); return; }
  f.dataset.submitted = '1';
  f.querySelectorAll('button[type=submit],button:not([type])').forEach(function (b) { b.disabled = true; });
});
window.addEventListener('pageshow', function () {
  document.querySelectorAll('form[data-submitted]').forEach(function (f) {
    delete f.dataset.submitted;
    f.querySelectorAll('button').forEach(function (b) { b.disabled = false; });
  });
});
if (location.search.indexOf('msg=') > -1 && history.replaceState) {
  history.replaceState(null, '', location.pathname + location.search.replace(/[?&]msg=[^&]*/, '').replace(/^&/, '?'));
}
`;

// ---------- Icons (inline SVG, Lucide-style strokes) ----------
const ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8"/><path d="M18.5 14.5A6.5 6.5 0 0 1 21.5 20"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h6"/>',
  briefcase: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M3 13h18"/>',
  team: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  calendar: '<rect x="3" y="4.5" width="18" height="16.5" rx="2"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13.5" r="3.5"/>',
  chev: '<path d="m9 6 6 6-6 6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  logout: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 17l-5-5 5-5"/><path d="M5 12h11"/>',
  pin: '<path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
  phone: '<path d="M5 3h3l2 5-2.5 1.5a11 11 0 0 0 7 7L16 14l5 2v3a2 2 0 0 1-2 2A16 16 0 0 1 3 5a2 2 0 0 1 2-2z"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  account: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="10" r="3"/><path d="M6.2 18.5a7 7 0 0 1 11.6 0"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l3 3M15 8l2 2"/>',
  download: '<path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7"/>',
  card: '<rect x="2.5" y="5" width="19" height="14" rx="2"/><path d="M2.5 10h19M6.5 15h4"/>',
  building: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2M10 21v-3h4v3"/>',
};
const icon = (name, cls = '') => raw(`<svg class="svg ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`);
const chev = () => html`<span class="chev">${icon('chev', 'sm')}</span>`;

// ---------- Formatting helpers ----------
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// '2026-11-10' -> <time datetime="2026-11-10">Nov 10, 2026</time>
function fmtDate(d, { year = true } = {}) {
  if (!d) return '';
  const [y, m, day] = d.split('-').map(Number);
  return html`<time datetime="${d}">${MONTHS[m - 1]} ${day}${year ? `, ${y}` : ''}</time>`;
}
function dateRange(start, end) {
  if (!start && !end) return '';
  if (start && end && start !== end) return html`${fmtDate(start, { year: start.slice(0, 4) !== end.slice(0, 4) })} – ${fmtDate(end)}`;
  return fmtDate(start || end);
}
// '14:30:00' -> '2:30 PM'
// Minutes as "3h 25m".
const fmtHours = (min) => { const m = Math.max(0, Math.round(Number(min) || 0)); return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`; };
const PAY_TYPES = { sub: 'Subcontractor', w2: 'W-2 employee' };
const payLabel = (m) => (m.pay_type === 'w2' ? `W-2${m.hourly_rate_cents != null ? ` · ${fmt(m.hourly_rate_cents)}/hr` : ''}` : 'Subcontractor');
const fmtTime = (t) => { if (!t) return ''; const [h, m] = t.split(':').map(Number); return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
const pill = (status, labels) => html`<span class="pill ${status}">${labels[status] || status}</span>`;

// ---------- Layout ----------
// The Keystone logo: the outline of an arch's keystone (same shape as public/icon.svg).
const LOGO = raw('<svg viewBox="0 0 512 512" aria-hidden="true"><path d="M120 150 Q256 118 392 150 L340 372 Q256 356 172 372 Z" fill="none" stroke="#fff" stroke-width="52" stroke-linejoin="round"/></svg>');
// The server fills <!--NAV--> (sidebar + tab bar) and <!--AVATAR--> for the signed-in user.
function layout(title, body, { flash, back, sub, fab, bare = false, pageTitle, docTitle } = {}) {
  return html`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#f3f4f8" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0b0d14" media="(prefers-color-scheme: dark)">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default"><meta name="apple-mobile-web-app-title" content="Keystone">
<link rel="manifest" href="/static/manifest.webmanifest"><link rel="icon" href="/static/icon.svg" type="image/svg+xml"><link rel="icon" href="/static/icon-192.png" type="image/png" sizes="192x192">
<link rel="apple-touch-icon" href="/static/apple-touch-icon.png">
<title>${docTitle || `${title} · Keystone`}</title><style>${raw(CSS)}</style></head>
<body>
${flash ? html`<div class="toast" role="status">${flash}</div>` : ''}
${bare ? body : html`<div class="shell">
${raw('<!--NAV-->')}
<div class="main">
  <header class="appbar"><div class="appbar-row">
    ${back ? html`<a class="back" href="${back.href}">${icon('chev')}${back.label}</a>` : ''}
    <span class="appbar-spacer"></span>${raw('<!--AVATAR-->')}
  </div></header>
  <div class="content">
    <h1 class="page-title">${pageTitle ?? title}</h1>
    ${sub ? html`<p class="page-sub">${sub}</p>` : ''}
    ${body}
  </div>
</div>
${fab ? html`<a class="fab" href="${fab.href}">${icon('plus')}${fab.label}</a>` : ''}
</div>`}
<script>${raw(JS)}</script>
</body></html>`.s;
}

const ADMIN_TABS = [['/', 'Home', 'home'], ['/clients', 'Clients', 'users'], ['/estimates', 'Estimates', 'file'], ['/jobs', 'Jobs', 'briefcase'], ['/team', 'Team', 'team']];
const CREW_TABS = [['/', 'Overview', 'home'], ['/schedule', 'Jobs', 'briefcase'], ['/team', 'Team', 'team']];
const activeTab = (path, href) => (href === '/' ? path === '/' : path.startsWith(href));

function nav({ user, org, path = '/' }) {
  const tabs = !org ? [['/account', 'Account', 'account']] : org.role === 'admin' ? ADMIN_TABS : CREW_TABS;
  const initial = initialOf(user);
  return {
    nav: html`<nav class="sidebar" aria-label="Main">
      <a class="brand" href="/"><span class="mark">${LOGO}</span>${org ? org.name : 'Keystone'}</a>
      ${tabs.map(([href, label, ic]) => html`<a class="nav ${activeTab(path, href) ? 'on' : ''}" href="${href}">${icon(ic)}${label}</a>`)}
      <span class="grow"></span>
      ${org ? html`<a class="nav ${path.startsWith('/account') ? 'on' : ''}" href="/account">${icon('account')}Account</a>` : ''}
      <div class="who"><span class="avatar">${initial}</span><div style="min-width:0">${who(user)}<small>${org ? ROLES[org.role] : ''}</small></div></div>
    </nav>
    <nav class="tabbar" aria-label="Tabs">${tabs.map(([href, label, ic]) =>
      html`<a class="${activeTab(path, href) ? 'on' : ''}" href="${href}">${icon(ic)}<span>${label}</span></a>`)}</nav>`.s,
    avatar: html`<a class="avatar" href="/account" aria-label="Account">${initial}</a>`.s,
  };
}

// ---------- Form helpers ----------
function errorBox(errors) {
  const list = Object.values(errors || {}).flat();
  if (!list.length) return '';
  return html`<div class="errors" role="alert"><strong>Not saved. Please fix the following and try again:</strong>
    <ul>${list.map((e) => html`<li>${e}</li>`)}</ul></div>`;
}
const fieldErr = (errors, k) => (errors && errors[k] ? html`<div class="field-error">${errors[k]}</div>` : '');
const inv = (errors, k) => (errors && errors[k] ? 'invalid' : '');

function input(name, label, values, errors, { type = 'text', required = false, placeholder = '', inputmode, autocomplete, hint } = {}) {
  return html`<label for="${name}">${label}${required ? ' *' : ''}</label>
  <input id="${name}" name="${name}" type="${type}" value="${values[name] ?? ''}" class="${inv(errors, name)}"
    ${required ? raw('required') : ''} ${placeholder ? raw(`placeholder="${placeholder}"`) : ''}
    ${inputmode ? raw(`inputmode="${inputmode}"`) : ''} ${autocomplete ? raw(`autocomplete="${autocomplete}"`) : ''}>
  ${fieldErr(errors, name)}${hint ? html`<div class="hint">${hint}</div>` : ''}`;
}
function textarea(name, label, values, errors, { placeholder = '' } = {}) {
  return html`<label for="${name}">${label}</label>
  <textarea id="${name}" name="${name}" class="${inv(errors, name)}" ${placeholder ? raw(`placeholder="${placeholder}"`) : ''}>${values[name] ?? ''}</textarea>${fieldErr(errors, name)}`;
}
const options = (labels, selected) => Object.entries(labels).map(([k, l]) =>
  html`<option value="${k}" ${selected === k ? raw('selected') : ''}>${l}</option>`);
const roleSelect = (name, selected, id) => html`<select name="${name}" ${id ? raw(`id="${id}"`) : ''}>${options(ROLES, selected)}</select>`;

// ---------- Privacy policy and terms (public) ----------
const LEGAL_UPDATED = 'October 20, 2026';
const SUPPORT_EMAIL = 'support@keystonefsm.com';
const LEGAL = {
  privacy: { title: 'Privacy Policy', body: html`
    <p>Keystone is business-management software for contractors and other service companies ("Keystone", "we", "us"). This policy explains what we collect, why, and the choices you have.</p>
    <h2>What we collect</h2>
    <ul>
      <li><strong>Account details:</strong> your email address and password (stored by our sign-in provider, never in plain text), and the optional name, phone number and ZIP code you add.</li>
      <li><strong>Business records you enter:</strong> your company profile and logo, clients and their contact details, estimates, line items, signatures, jobs, schedules, crew assignments and pay, time clock entries, expenses, receipts, job photos, invoices and payments.</li>
      <li><strong>Information from connected services:</strong> if you connect Stripe, we store your Stripe account ID and invoice and payment records; card and bank details are handled by Stripe and never reach us.</li>
      <li><strong>Technical data:</strong> sign-in cookies, and basic server logs (such as IP address and pages requested) used to keep the service secure and working.</li>
    </ul>
    <h2>How we use it</h2>
    <p>Only to provide and improve Keystone: to show your records to the people on your team, send estimates, invoices and reminder emails you set up, process subscription billing, keep accounts secure, and answer support requests. We don't sell personal information or use it for advertising.</p>
    <h2>Who can see your data</h2>
    <p>Each company's records are kept separate and are visible only to that company's team. Admins see everything in their company; crew see only the jobs assigned to them and their own pay. Your clients see only the estimates and invoices you send them.</p>
    <p>We share data with the service providers that run Keystone, only as needed: Supabase (database and sign-in), Render (hosting), Stripe (payments and subscriptions) and Resend (email delivery). We may disclose information if the law requires it.</p>
    <h2>Keeping and deleting data</h2>
    <p>We keep your records while your company uses Keystone. You can delete your account yourself at any time in the app (Account, then Delete account), and an admin can delete their company and all of its records (Company profile, then Delete company). Deletion takes effect right away; copies in our backups are erased within 30 days. You can also email us to ask for deletion or a copy of your data. We keep only what the law requires, such as billing records. See <a href="/data-deletion">how to delete your data</a>.</p>
    <h2>Security</h2>
    <p>Data is sent over encrypted connections, access is limited by company and role in the database itself, and connection tokens can be read only by the Keystone server. No system is perfectly secure, so please use a strong, unique password.</p>
    <h2>Children</h2>
    <p>Keystone is for businesses and isn't meant for anyone under 18.</p>
    <h2>Changes</h2>
    <p>If we change this policy, we'll update the date above and, for significant changes, tell account admins by email or in the app.</p>` },
  support: { title: 'Help & support', body: html`
    <p>We're here to help with anything in Keystone: setting up your company, inviting your crew, estimates, invoicing and your plan.</p>
    <h2>Contact us</h2>
    <p>Email <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a> and we'll reply within one business day. Include your company name and what you were trying to do.</p>
    <h2>Common questions</h2>
    <ul>
      <li><strong>Forgot your password?</strong> Use <a href="/forgot">Reset your password</a> and we'll email you a link.</li>
      <li><strong>Joining your company?</strong> Create an account, then enter the join code your admin gives you.</li>
      <li><strong>Getting paid online?</strong> Admins connect their own Stripe account in Company profile. Payments go straight to you.</li>
      <li><strong>Changing or cancelling your plan?</strong> Admins can do it any time in Account, then Plan &amp; billing.</li>
      <li><strong>Deleting your account or data?</strong> See <a href="/data-deletion">how to delete your data</a>.</li>
    </ul>` },
  'data-deletion': { title: 'Delete your data', body: html`
    <p>You can delete your Keystone data yourself at any time. Deletion can't be undone.</p>
    <h2>Delete your account</h2>
    <ol>
      <li>Log in and open <strong>Account</strong> (your initial at the top of the screen).</li>
      <li>Choose <strong>Delete account</strong> at the bottom and confirm.</li>
    </ol>
    <p>This removes your login, your profile and your access to every company. If you're the only admin of a company that has other people on it, make someone else an admin or delete the company first. Records a company keeps about work you did for it (such as jobs and hours) stay with that company, without your name or email.</p>
    <h2>Delete a company</h2>
    <p>Admins can open <strong>Company profile</strong> and choose <strong>Delete company</strong>. This permanently deletes all of that company's clients, estimates, jobs, photos, receipts, invoices and payments records, and cancels its paid plan. Payments already collected in your own Stripe account stay there.</p>
    <h2>Can't log in?</h2>
    <p>Email <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a> from the address on your account and we'll delete it within 30 days. Copies in our backups are erased within 30 days of deletion.</p>` },
  terms: { title: 'Terms of Use', body: html`
    <p>These terms are an agreement between you (and the company you use Keystone for) and Keystone ("we", "us"). By creating an account or using Keystone, you agree to them.</p>
    <h2>Your account</h2>
    <p>You must give accurate information and keep your password safe. You're responsible for what happens under your account and for the teammates you invite. Company admins decide who is on their team and what role they have.</p>
    <h2>Your data</h2>
    <p>You own the business records you put into Keystone. You give us permission to store and process them only to run the service for you, as described in our <a href="/privacy">Privacy Policy</a>. You're responsible for having the right to enter your clients' and crew's information and for any messages you send them through Keystone.</p>
    <h2>Acceptable use</h2>
    <p>Don't use Keystone to break the law, send spam, upload harmful code, access other companies' data, or interfere with the service.</p>
    <h2>Plans and billing</h2>
    <p>Some features need a paid plan. Paid plans renew automatically each month or year until cancelled, and are billed through Stripe. You can cancel any time from Plan &amp; billing; your plan stays active until the end of the paid period. Except where the law requires, payments aren't refunded. We'll give notice before changing prices.</p>
    <h2>Connected services</h2>
    <p>Stripe and other services you connect are provided by their own companies under their own terms. Payments you collect go to your own Stripe account; Keystone isn't a party to them. We aren't responsible for those services' availability or for changes you make in them.</p>
    <h2>No warranty</h2>
    <p>Keystone is provided "as is". We work to keep it accurate and available but don't promise it will be error-free or uninterrupted. Totals, profit figures and synced records are tools to help you; check them before relying on them for tax, payroll or legal purposes.</p>
    <h2>Limitation of liability</h2>
    <p>To the extent the law allows, we aren't liable for indirect or consequential losses, lost profits or lost data, and our total liability is limited to what you paid us for Keystone in the 12 months before the claim.</p>
    <h2>Ending use</h2>
    <p>You can stop using Keystone at any time. We may suspend or close accounts that break these terms or don't pay. You can ask for a copy of your data before your account is closed.</p>
    <h2>General</h2>
    <p>These terms are governed by the laws of the Commonwealth of Pennsylvania. If we change them, we'll update the date above; continuing to use Keystone after a change means you accept it.</p>` },
};
function legalPage(kind) {
  const d = LEGAL[kind];
  return layout(d.title, html`<div class="legal">
    <a class="mark lg" href="/" aria-label="Keystone">${LOGO}</a>
    <h1>${d.title}</h1><p class="muted">Keystone · Last updated ${LEGAL_UPDATED}</p>
    ${d.body}
    <h2>Contact</h2><p>Questions or requests: <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.</p>
    ${footerLinks()}
  </div>`, { bare: true, docTitle: `${d.title} · Keystone` });
}
const footerLinks = () => html`<p class="muted footer-links"><a href="/privacy">Privacy</a> · <a href="/terms">Terms</a> · <a href="/support">Support</a> · <a href="/data-deletion">Delete your data</a></p>`;

// Public home page for people who aren't logged in (also what app stores and Google/Meta reviewers see).
const FEATURES = [
  ['file', 'Estimates that close', 'Good, better and best options, a link your client approves and signs on their phone, and the deposit invoiced automatically.'],
  ['calendar', 'Schedule and crew', 'Jobs on a calendar, crew assigned in a tap, and each person sees only their own jobs, address and scope.'],
  ['check', 'Time clock and payouts', 'W-2 crew clock in on the job; subcontractors get fixed payouts. Labor lands on the job automatically.'],
  ['card', 'Invoices and payments', 'Deposits and progress invoices paid online by card or bank, straight to your own Stripe account.'],
  ['camera', 'Photos and receipts', 'Before and after photos and expense receipts stored right on the job.'],
  ['briefcase', 'Know your numbers', 'Real gross profit on every job and revenue by month, so you see which work pays.'],
];
function landingPage() {
  return layout('Keystone', html`<div class="landing">
    <header class="lp-top"><a class="lp-brand" href="/"><span class="mark">${LOGO}</span>Keystone</a>
      <nav><a href="/login">Log in</a><a class="btn sm" href="/signup">Start free</a></nav></header>
    <section class="lp-hero">
      <h1>Run your crews, estimates and payments in one place.</h1>
      <p>Keystone is field service software for painters, remodelers, flooring and other trade contractors. Win the job, schedule the crew, track the cost and get paid.</p>
      <div class="lp-cta"><a class="btn" href="/signup">Start free</a><a class="btn secondary" href="/login">Log in</a></div>
      <p class="hint">Free for one person. No credit card needed.</p>
    </section>
    <section class="lp-grid">${FEATURES.map(([ic, t, d]) => html`<div class="card"><span class="icon-bubble">${icon(ic)}</span><h3>${t}</h3><p>${d}</p></div>`)}</section>
    <section class="lp-pricing"><h2>Simple pricing</h2>
      <div class="lp-grid">
        <div class="card"><h3>Free</h3><div class="lp-price">$0</div><p>One person running their own business.</p></div>
        <div class="card"><h3>Team</h3><div class="lp-price">${dollars(PRICES.team.month)}<span>/mo</span></div><p>Up to 3 admins and 10 crew. ${dollars(PRICES.team.year)} a year if you pay yearly.</p></div>
        <div class="card"><h3>Unlimited</h3><div class="lp-price">${dollars(PRICES.unlimited.month)}<span>/mo</span></div><p>Unlimited admins and crew. ${dollars(PRICES.unlimited.year)} a year if you pay yearly.</p></div>
      </div>
      <p class="hint">50% off your first month on monthly plans.</p></section>
    <footer class="lp-foot">${footerLinks()}<p class="muted">© ${new Date().getFullYear()} Keystone · <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a></p></footer>
  </div>`, { bare: true, docTitle: 'Keystone · Field service software for trade contractors' });
}

// ---------- Auth & onboarding ----------
function authPage(title, sub, body) {
  return layout(title, html`<div class="auth">
    <div class="mark lg">${LOGO}</div>
    <h1>${title}</h1><p class="sub">${sub}</p>
    ${body}
  </div>`, { bare: true });
}

function loginPage({ error, notice, email = '' } = {}) {
  return authPage('Welcome back', 'Log in to Keystone', html`
    ${error ? html`<div class="errors" role="alert">${error}</div>` : ''}
    ${notice ? html`<div class="notice">${notice}</div>` : ''}
    <form method="post" action="/login" class="form-card">
      <label for="email">Email</label>
      <input id="email" name="email" type="email" autocomplete="email" inputmode="email" value="${email}" required autofocus>
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required>
      <div class="form-actions"><button type="submit">Log in</button></div>
    </form>
    <p class="alt"><a href="/forgot">Forgot your password?</a></p>
    <p class="alt">New here? <a href="/signup">Create an account</a></p>
    <div style="text-align:center">${footerLinks()}</div>`);
}

function forgotPage({ sent = false, error, email = '' } = {}) {
  return authPage('Reset your password', 'We\'ll email you a link to choose a new one.', html`
    ${error ? html`<div class="errors" role="alert">${error}</div>` : ''}
    ${sent ? html`<div class="notice">If there's a Keystone account for ${email}, a reset link is on its way. Check your inbox and spam folder.</div>` : html`
    <form method="post" action="/forgot" class="form-card" novalidate>
      <label for="email">Email</label>
      <input id="email" name="email" type="email" autocomplete="email" inputmode="email" value="${email}" required autofocus>
      <div class="form-actions"><button type="submit">Email me a link</button></div>
    </form>`}
    <p class="alt"><a href="/login">Back to log in</a></p>`);
}

// The emailed link lands here with the one-time token in the address's #fragment, which only the browser sees.
function resetPage({ error, token = '' } = {}) {
  return authPage('Choose a new password', 'At least 8 characters.', html`
    ${error ? html`<div class="errors" role="alert">${error}</div>` : ''}
    <div class="errors" role="alert" id="link-error" style="display:none">This reset link is invalid or has expired. <a href="/forgot">Get a new link</a>.</div>
    <form method="post" action="/reset" class="form-card" id="reset-form" novalidate>
      <input type="hidden" name="token" id="token" value="${token}">
      <label for="password">New password</label>
      <input id="password" name="password" type="password" autocomplete="new-password" required>
      <div class="form-actions"><button type="submit">Save new password</button></div>
    </form>
    <p class="alt"><a href="/login">Back to log in</a></p>
    <script>${raw(`(function () {
      var h = new URLSearchParams(location.hash.slice(1)); var t = h.get('access_token');
      if (t && h.get('type') === 'recovery') { document.getElementById('token').value = t; history.replaceState(null, '', location.pathname); }
      else if (!document.getElementById('token').value) { document.getElementById('link-error').style.display = ''; document.getElementById('reset-form').style.display = 'none'; }
    })();`)}</script>`);
}

function signupPage({ errors = {}, values = {} } = {}) {
  return authPage('Create your account', 'Then join your company with a code, or start a new one.', html`
    ${errorBox(errors)}
    <form method="post" action="/signup" class="form-card" novalidate>
      ${input('email', 'Email', values, errors, { type: 'email', required: true, autocomplete: 'email', inputmode: 'email' })}
      <label for="password">Password *</label>
      <input id="password" name="password" type="password" autocomplete="new-password" class="${inv(errors, 'password')}" required>
      ${fieldErr(errors, 'password')}<div class="hint">At least 8 characters.</div>
      <h3 style="margin-top:18px">About you <span class="muted" style="font-weight:500">(optional)</span></h3>
      ${input('full_name', 'Your name', values, errors, { autocomplete: 'name' })}
      ${input('phone', 'Phone', values, errors, { type: 'tel', autocomplete: 'tel', inputmode: 'tel' })}
      ${input('zip', 'ZIP code', values, errors, { autocomplete: 'postal-code', inputmode: 'numeric' })}
      <div class="hint">Shown to your company's admins. You can change these later in Account.</div>
      <div class="form-actions"><button type="submit">Create account</button></div>
      <p class="hint" style="text-align:center">By creating an account you agree to the <a href="/terms">Terms of Use</a> and <a href="/privacy">Privacy Policy</a>.</p>
    </form>
    <p class="alt">Already have an account? <a href="/login">Log in</a></p>`);
}

function welcomePage({ errors = {}, values = {}, hasOrgs }) {
  return layout(hasOrgs ? 'Join or create' : 'Get started', html`
  ${errorBox(errors)}
  <form method="post" action="/org/join" class="form-card" novalidate>
    <h3>Join your company</h3>
    <div class="hint">Ask your admin for the company's join code. You'll join as crew; your admin can change that.</div>
    ${input('code', 'Join code', values, errors, { placeholder: 'ABCD-2345', autocomplete: 'off' })}
    <div class="form-actions"><button type="submit">Join company</button></div>
  </form>
  <form method="post" action="/org/new" class="form-card" novalidate>
    <h3>Start a new company</h3>
    <div class="hint">For owners setting up Keystone for the first time. You'll be its admin.</div>
    ${input('name', 'Company name', values, errors)}
    <div class="form-actions"><button type="submit" class="secondary">Create company</button></div>
  </form>`, { sub: hasOrgs ? null : 'One last step before you start.', back: hasOrgs ? { href: '/account', label: 'Account' } : null });
}

function accountPage({ user, org, orgs, plan, theme = '', values = {}, errors = {}, flash }) {
  return layout('Account', html`
  <div class="list">
    <div class="li"><span class="avatar">${initialOf(user)}</span><div class="main-t"><div class="t">${who(user)}</div>
      <div class="s">${user.name ? `${user.email} · ` : ''}${org ? `${ROLES[org.role]} at ${org.name}` : 'Not in a company yet'}</div></div></div>
  </div>
  ${errorBox(errors)}
  <form method="post" action="/account/profile" class="form-card" novalidate id="profile-form">
    <h3>Your details</h3>
    <div class="hint">All optional. Your company's admins can see them.</div>
    ${input('full_name', 'Name', values, errors, { autocomplete: 'name' })}
    ${input('phone', 'Phone', values, errors, { type: 'tel', autocomplete: 'tel', inputmode: 'tel' })}
    ${input('zip', 'ZIP code', values, errors, { autocomplete: 'postal-code', inputmode: 'numeric' })}
    <div class="form-actions"><button type="submit" class="secondary">Save details</button></div>
  </form>
  <form method="post" action="/account/theme" class="form-card" id="appearance">
    <h3>Appearance</h3>
    <div class="hint">Saved on this device.</div>
    <div class="seg" role="radiogroup" aria-label="Appearance">${[['', 'Automatic'], ['light', 'Light'], ['dark', 'Dark']].map(([k, l]) =>
      html`<button type="submit" name="theme" value="${k || 'system'}" class="${theme === k ? 'on' : ''}" aria-pressed="${theme === k ? 'true' : 'false'}">${l}</button>`)}</div>
    <div class="hint">Automatic follows your phone or computer's setting.</div>
  </form>
  ${orgs.length > 1 ? html`<h2>Switch company</h2><div class="list">${orgs.map((o) => html`
    <form method="post" action="/org/switch" class="li" style="margin:0">
      <input type="hidden" name="org_id" value="${o.org_id}">
      <span class="icon-bubble">${icon('building')}</span>
      <div class="main-t"><div class="t">${o.name}</div><div class="s">${ROLES[o.role]}</div></div>
      ${org && o.org_id === org.org_id ? html`<span class="pill completed">Current</span>` : html`<button type="submit" class="sm secondary">Switch</button>`}
    </form>`)}</div>` : ''}
  ${org && org.role === 'admin' ? html`<div class="list"><a class="li" href="/settings"><span class="icon-bubble">${icon('settings')}</span>
    <div class="main-t"><div class="t">Company profile</div><div class="s">Logo and details on estimates and work orders</div></div>${chev()}</a>
    <a class="li" href="/import"><span class="icon-bubble">${icon('download')}</span>
    <div class="main-t"><div class="t">Import</div><div class="s">Clients and jobs from Jobber, Housecall Pro, QuickBooks or a spreadsheet</div></div>${chev()}</a>
    <a class="li" href="/billing"><span class="icon-bubble">${icon('card')}</span>
    <div class="main-t"><div class="t">Plan & billing</div><div class="s">${PLAN_NAMES[plan] || 'Free'} plan</div></div>${chev()}</a></div>` : ''}
  <div class="actions">
    <a class="btn secondary" href="/welcome">${icon('key')}Join or create a company</a>
  </div>
  <form method="post" action="/logout"><button type="submit" class="danger block">${icon('logout')}Log out</button></form>
  <p class="hint" style="text-align:center;margin-top:18px"><a href="/account/delete" id="delete-account" style="color:var(--red)">Delete account</a></p>
  <div style="text-align:center">${footerLinks()}</div>`, { flash });
}

// Deleting your own account (required by the app stores). Blocked while you're the only admin of a company with other people.
function deleteAccountPage({ user, blockers = [], companies = [], error }) {
  return layout('Delete account', html`
  ${error ? html`<div class="errors" role="alert">${error}</div>` : ''}
  ${blockers.length ? html`<div class="card">
    <h3>First, hand off or delete your company</h3>
    <p>You're the only admin of ${blockers.map((b, i) => html`${i ? ', ' : ''}<strong>${b.name}</strong>`)}, which has other people on it.
      Make someone else an admin on the Team page, or delete the company in Company profile, then come back here.</p>
  </div>` : html`<form method="post" action="/account/delete" class="form-card" novalidate>
    <p style="margin-top:0">This permanently deletes the Keystone login for <strong>${user.email}</strong> and your profile, and removes you from every company. It can't be undone.</p>
    ${companies.length ? html`<p>Because you're the only person in it, this also deletes ${companies.map((c, i) => html`${i ? ', ' : ''}<strong>${c.name}</strong>`)} and all of its records, and cancels its paid plan.</p>` : ''}
    <p class="muted">Records other companies keep about work you did for them (such as jobs and hours) stay with them, without your name or email.</p>
    <label for="confirm">Type DELETE to confirm</label>
    <input id="confirm" name="confirm" autocomplete="off" autocapitalize="characters">
    <div class="form-actions"><a class="btn secondary" href="/account">Cancel</a><button type="submit" class="danger">Delete my account</button></div>
  </form>`}`, { back: { href: '/account', label: 'Account' } });
}

// Import from another app's CSV export: 1) upload, 2) check the column matches and preview, 3) import.
const IMPORT_KINDS = { clients: 'Clients', jobs: 'Jobs' };
function importPage({ kind = 'clients', step = 1, csv = '', fileName = '', headers = [], fields = [], map = {}, preview = [], result = null, error }) {
  const opt = (sel) => html`<option value="">Not in file</option>${headers.map((h, i) => html`<option value="${i}" ${sel === i ? raw('selected') : ''}>${h || `Column ${i + 1}`}</option>`)}`;
  return layout('Import', html`
  ${error ? html`<div class="errors" role="alert">${error}</div>` : ''}
  ${step === 1 ? html`<form method="post" action="/import/preview" class="form-card" id="import-form" novalidate>
    <h3>1. Export from your old app</h3>
    <p class="hint">In Jobber, Housecall Pro, QuickBooks or any spreadsheet, export your clients or jobs as a <strong>CSV</strong> file.
      Excel and Google Sheets: File, then Download or Save as, then CSV.</p>
    <h3 style="margin-top:16px">2. What's in the file?</h3>
    <div class="seg" role="radiogroup">${Object.entries(IMPORT_KINDS).map(([k, l]) => html`<label class="${kind === k ? 'on' : ''}" style="flex:1;text-align:center;cursor:pointer">
      <input type="radio" name="kind" value="${k}" ${kind === k ? raw('checked') : ''} style="display:none">${l}</label>`)}</div>
    <p class="hint">Jobs also create their clients, so if you have both in one file, choose Jobs.</p>
    <h3 style="margin-top:16px">3. Choose the file</h3>
    <label class="btn secondary block" for="csv-file" style="margin:8px 0;color:var(--accent)">${icon('download')}Choose CSV file</label>
    <input type="file" id="csv-file" accept=".csv,text/csv" style="display:none">
    <div class="hint" id="file-name">${fileName || 'No file chosen'}</div>
    <input type="hidden" name="file_name" id="file_name" value="${fileName}">
    <details style="margin-top:10px"><summary class="hint" style="cursor:pointer">Or paste the CSV text</summary>
      <textarea name="csv" id="csv" rows="6" placeholder="Name,Email,Phone&#10;Jane Rivera,jane@example.com,555-123-4567">${csv}</textarea></details>
    <div class="form-actions"><button type="submit">Continue</button></div>
  </form>
  <script>${raw(`(function () {
    var seg = document.querySelectorAll('#import-form .seg label');
    seg.forEach(function (l) { l.addEventListener('click', function () { seg.forEach(function (x) { x.classList.toggle('on', x === l); }); }); });
    document.getElementById('csv-file').addEventListener('change', function (e) {
      var f = e.target.files[0]; if (!f) return;
      if (f.size > 3000000) { alert('That file is over 3 MB. Split it into smaller files and import each one.'); return; }
      var r = new FileReader();
      r.onload = function () { document.getElementById('csv').value = r.result; document.getElementById('file-name').textContent = f.name;
        document.getElementById('file_name').value = f.name; document.getElementById('import-form').submit(); };
      r.readAsText(f);
    });
  })();`)}</script>` : html`
  <form method="post" action="/import/preview" id="import-form" novalidate>
    <input type="hidden" name="kind" value="${kind}"><input type="hidden" name="file_name" value="${fileName}">
    <textarea name="csv" hidden>${csv}</textarea>
    <p class="hint" style="margin:0 4px 12px">${fileName ? html`<strong>${fileName}</strong> · ` : ''}${result.total} row${result.total === 1 ? '' : 's'} of ${IMPORT_KINDS[kind].toLowerCase()}.
      <a href="/import">Start over</a></p>
    <h2>Match your columns</h2>
    <p class="hint" style="margin:0 4px 8px">We've matched what we could. Fix any that are wrong, then update the preview.</p>
    <div class="form-card" id="mapping">${fields.map(([key, label]) => html`<div class="two" style="align-items:center;margin-bottom:6px">
      <label for="map_${key}" style="margin:0">${label}</label>
      <select id="map_${key}" name="map_${key}">${opt(map[key])}</select></div>`)}
      <p class="hint">Client name can come from one column, from first and last name, or from company. Address parts are joined into one address.</p>
      <div class="form-actions"><button type="submit" class="secondary">Update preview</button></div>
    </div>
    <h2>Preview</h2>
    <div class="stats" id="import-summary">
      <div class="stat good"><div class="k">Ready to import</div><div class="v" data-k="ready">${result.ok.length}</div></div>
      <div class="stat"><div class="k">Already in Keystone (skipped)</div><div class="v" data-k="dupes">${result.dupes}</div></div>
      <div class="stat ${result.problems.length ? 'bad' : ''}"><div class="k">Need fixing (skipped)</div><div class="v" data-k="problems">${result.problems.length}</div></div>
    </div>
    ${preview.length ? html`<div class="list">${preview.map((r) => html`<div class="li"><div class="main-t">
      <div class="t">${r.job ? r.job.title : r.client.name}</div>
      <div class="s">${r.job ? `${r.client.name}${r.job.address ? ` · ${r.job.address}` : ''} · ${fmt(r.job.amount)}${r.job.start_date ? ` · ${r.job.start_date}` : ''} · ${JOB_STATUS[r.job.status]}`
        : [r.client.email, r.client.phone, r.client.address].filter(Boolean).join(' · ') || 'No contact details'}</div></div></div>`)}</div>
    ${result.ok.length > preview.length ? html`<p class="hint" style="margin:0 4px">…and ${result.ok.length - preview.length} more.</p>` : ''}` : ''}
    ${result.problems.length ? html`<h2>Rows that need fixing</h2><div class="card" id="import-problems"><ul style="margin:0;padding-left:18px">
      ${result.problems.slice(0, 25).map((p) => html`<li>Line ${p.line}${p.name ? ` (${p.name})` : ''}: ${p.why}</li>`)}</ul>
      ${result.problems.length > 25 ? html`<p class="hint">…and ${result.problems.length - 25} more.</p>` : ''}
      <p class="hint">Fix these in your file and import it again later; rows already imported are skipped automatically.</p></div>` : ''}
    <div class="totalbar">
      <div class="grow"><div class="lbl">Importing</div><div class="num">${result.ok.length} ${IMPORT_KINDS[kind].toLowerCase()}</div></div>
      <button type="submit" formaction="/import/run" ${result.ok.length ? '' : raw('disabled')} id="run-import">Import</button>
    </div>
  </form>`}`, { back: { href: '/clients', label: 'Clients' },
    sub: step === 1 ? 'Bring your clients and jobs over from Jobber, Housecall Pro, QuickBooks or a spreadsheet.' : null });
}

function deleteCompanyPage({ org, error }) {
  return layout('Delete company', html`
  ${error ? html`<div class="errors" role="alert">${error}</div>` : ''}
  <form method="post" action="/settings/delete-company" class="form-card" novalidate>
    <p style="margin-top:0">This permanently deletes <strong>${org.name}</strong> for everyone on its team: all clients, estimates, jobs, photos, receipts, time entries, invoices and payment records. Its paid plan is cancelled. It can't be undone.</p>
    <p class="muted">Payments already collected stay in your own Stripe account. Your login stays, so you can still use other companies or start a new one.</p>
    <label for="confirm">Type the company name to confirm</label>
    <input id="confirm" name="confirm" autocomplete="off" placeholder="${org.name}">
    <div class="form-actions"><a class="btn secondary" href="/settings">Cancel</a><button type="submit" class="danger">Delete company</button></div>
  </form>`, { back: { href: '/settings', label: 'Company profile' } });
}

// ---------- Company profile ----------
function settingsPage({ org, values, hasLogo, errors = {}, flash, payments = null, emailValues = null, emailErrors = {}, emailEnabled = false, texting = {} }) {
  return layout('Company profile', html`
  ${errorBox(errors)}
  <form method="post" action="/settings" id="settings-form" novalidate>
    <div class="form-card">
      <h3>Logo</h3>
      <div class="hint">PNG or JPG. Shown at the top of estimates and work orders.</div>
      <div class="row" style="margin-top:12px;align-items:center">
        <div id="logo-preview" style="width:150px;height:64px;border-radius:12px;background:var(--surface-2);display:grid;place-items:center;overflow:hidden">
          ${hasLogo ? html`<img src="/settings/logo?v=${Date.now()}" alt="Company logo" style="width:150px;height:64px;object-fit:contain">` : html`<span class="muted" style="font-size:13px">No logo</span>`}
        </div>
        <label class="btn sm secondary" for="logo-file" style="margin:0;color:var(--accent)">Choose image</label>
        ${hasLogo ? html`<label style="margin:0;display:flex;gap:6px;align-items:center;font-weight:500"><input type="checkbox" name="remove_logo" value="1" style="width:18px;min-height:0;height:18px">Remove</label>` : ''}
      </div>
      <input type="file" id="logo-file" accept="image/png,image/jpeg" style="display:none">
      <input type="hidden" name="logo_data" id="logo_data" value="">
      ${fieldErr(errors, 'logo')}
    </div>
    <div class="form-card">
      <h3>Business details</h3>
      ${input('name', 'Company name', values, errors, { required: true })}
      <div class="two stack"><div>${input('phone', 'Phone', values, errors, { type: 'tel', inputmode: 'tel' })}</div>
      <div>${input('email', 'Email', values, errors, { type: 'email', inputmode: 'email' })}</div></div>
      ${input('address', 'Business address', values, errors)}
      <div class="two stack"><div>${input('website', 'Website', values, errors, { placeholder: 'yourcompany.com' })}</div>
      <div>${input('license_number', 'License number', values, errors)}</div></div>
    </div>
    <div class="form-card">
      <h3>Fine print</h3>
      ${textarea('estimate_terms', 'Estimate terms', values, errors, { placeholder: 'e.g. Valid for 30 days. 50% deposit to schedule, balance due on completion.' })}
      ${textarea('work_order_terms', 'Work order terms', values, errors, { placeholder: 'e.g. Clean up daily. Call the office before any change to the scope.' })}
    </div>
    <div class="form-actions"><a class="btn secondary" href="/account">Cancel</a><button type="submit">Save profile</button></div>
  </form>
  ${payments ? html`<h2>Online payments</h2><div class="card" id="online-payments">${paymentsCard(payments)}</div>` : ''}
  ${emailValues ? emailSettings(emailValues, emailErrors, emailEnabled, texting) : ''}
  <h2>Danger zone</h2>
  <div class="list"><a class="li" href="/settings/delete-company" id="delete-company"><div class="main-t"><div class="t" style="color:var(--red)">Delete company</div>
    <div class="s">Permanently delete ${org.name} and all of its records</div></div>${chev()}</a></div>
  <script>${raw(LOGO_JS)}</script>`, { flash, back: { href: '/account', label: 'Account' } });
}

function emailSettings(ev, errors, enabled, texting = {}) {
  const toggle = (name, label, hint) => html`<label class="check"><input type="checkbox" name="${name}" ${ev[name] ? raw('checked') : ''}>
    <span>${label}<div class="hint" style="font-weight:400;margin:2px 0 0">${hint}</div></span></label>`;
  // Each follow-up has its own email and text switch; texts can be switched on only once texting is set up for the company.
  const textToggle = (name) => html`<label class="check" style="margin-top:0"><input type="checkbox" name="${name}" ${ev[name] ? raw('checked') : ''} ${texting.ready ? '' : raw('disabled')}>
    <span>Also by text${texting.ready ? '' : html` <span class="muted" style="font-weight:400">(not set up yet)</span>`}</span></label>`;
  return html`<h2 id="emails">Automatic follow-ups</h2>
  ${errorBox(errors)}
  <form method="post" action="/settings/emails" class="form-card" novalidate id="email-settings">
    ${enabled ? '' : html`<div class="notice">Emailing isn't switched on for this app yet, so nothing will be sent. You can still set these up now.</div>`}
    <div class="hint" style="margin:0 0 8px">Every follow-up is optional. Emails come from your company name, and replies go to your business email above.
      ${texting.ready ? html`Texts come from your company's number ${texting.phone} and go only to clients marked "OK to text".`
        : html`Texting needs a one-time registration of your business with the phone carriers. To turn it on, email <a href="mailto:support@keystonefsm.com">support@keystonefsm.com</a>.`}</div>
    <label for="estimate_followup_days">Follow up on estimates that haven't been approved</label>
    <select id="estimate_followup_days" name="estimate_followup_days">${[['0', 'No email follow-up'], ['2', 'Email after 2 days, then 4'], ['3', 'Email after 3 days, then 6'], ['5', 'Email after 5 days, then 10'], ['7', 'Email after 7 days, then 14']]
      .map(([k, l]) => html`<option value="${k}" ${String(ev.estimate_followup_days) === k ? raw('selected') : ''}>${l}</option>`)}</select>
    ${textToggle('sms_estimate_followups')}
    ${toggle('appointment_reminders', 'Appointment reminders by email', 'The day before a job starts, remind the client.')}
    ${textToggle('sms_appointment_reminders')}
    ${toggle('review_requests', 'Review requests by email', 'An hour after you mark a job completed, ask the client for a review.')}
    ${textToggle('sms_review_requests')}
    ${input('review_url', 'Review link', ev, errors, { placeholder: 'https://g.page/r/…', hint: 'Your Google (or Yelp, Facebook…) review page.' })}
    ${input('default_deposit_percent', 'Default deposit for new estimates (%)', ev, errors, { inputmode: 'numeric', hint: 'Clients pay it online when they approve, if Stripe is connected. 0 for none.' })}
    <div class="form-actions"><button type="submit" class="secondary">Save follow-up settings</button></div>
  </form>`;
}

function paymentsCard({ configured, testMode, account }) {
  if (!configured) {
    return html`<strong>Not available yet.</strong><div class="hint">Online invoicing hasn't been switched on for this app. See "Online invoicing with Stripe" in the README.</div>`;
  }
  const test = testMode ? ' (test mode)' : '';
  if (account && account.charges_enabled) {
    return html`<div class="row" style="justify-content:space-between"><strong>Stripe connected${test}</strong><span class="pill completed">Ready</span></div>
      <div class="hint">Send invoices from any job with money owed. Clients pay your Stripe account directly, and paid invoices are recorded on the job automatically.</div>
      <div class="actions" style="margin:12px 0 0"><a class="btn secondary" href="https://dashboard.stripe.com" target="_blank" rel="noopener">Open Stripe dashboard</a></div>`;
  }
  return html`<strong>${account ? `Finish setting up Stripe${test}` : `Get paid online${test}`}</strong>
    <div class="hint">${account ? 'Stripe still needs some details before you can send invoices.'
      : 'Connect a Stripe account to email clients invoices they can pay by card or bank transfer. Money goes straight to your account; Stripe charges its standard fees per payment.'}</div>
    <form method="post" action="/settings/stripe/connect" style="margin-top:12px"><button type="submit" class="block" id="connect-stripe">${account ? 'Continue Stripe setup' : 'Connect Stripe'}</button></form>`;
}

// Shrinks the chosen image in the browser (max 800px wide) and sends it as a data URL.
const LOGO_JS = `
(function () {
  var file = document.getElementById('logo-file');
  file.addEventListener('change', function () {
    var f = file.files[0]; if (!f) return;
    var img = new Image();
    img.onload = function () {
      var scale = Math.min(1, 800 / img.width, 400 / img.height);
      var c = document.createElement('canvas');
      c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      var data = c.toDataURL(f.type === 'image/jpeg' ? 'image/jpeg' : 'image/png', 0.9);
      document.getElementById('logo_data').value = data;
      document.getElementById('logo-preview').innerHTML = '<img src="' + data + '" alt="" style="width:150px;height:64px;object-fit:contain">';
      URL.revokeObjectURL(img.src);
    };
    img.onerror = function () { alert('That file could not be read as an image. Try a PNG or JPG.'); };
    img.src = URL.createObjectURL(f);
  });
})();`;

// ---------- Plan & billing ----------
const PLAN_NAMES = { free: 'Free', team: 'Team', unlimited: 'Unlimited' };
const PRICES = { team: { month: 4900, year: 49900 }, unlimited: { month: 9900, year: 100900 } };
const dollars = (c) => `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;

function seatsLeft(plan, members) {
  const admins = members.filter((m) => m.role === 'admin').length;
  const workers = members.length - admins;
  if (plan === 'unlimited') return `${members.length} ${members.length === 1 ? 'person' : 'people'} · no limits`;
  if (plan === 'team') return `${admins} of 3 admins · ${workers} of 10 crew`;
  return members.length > 1 ? `${members.length} people · upgrade to add more` : 'Just you · upgrade to add your crew';
}

function billingPage({ org, sub, plan, counts, enabled, testMode, interval = 'month', error, flash }) {
  const paid = ['active', 'trialing', 'past_due'].includes(sub.status) && sub.plan !== 'free';
  const discount = interval === 'month' && !sub.first_month_discount_used;
  const usage = plan === 'team' ? `${counts.admins} of 3 admins · ${counts.workers} of 10 crew`
    : plan === 'unlimited' ? `${counts.admins + counts.workers} people` : `${counts.admins + counts.workers} of 1 person`;
  const renew = sub.current_period_end ? fmtDate(String(sub.current_period_end instanceof Date ? sub.current_period_end.toISOString() : sub.current_period_end).slice(0, 10)) : '';
  const card = (key, title, blurb, features) => {
    const price = PRICES[key];
    const current = plan === key && (key === 'free' || paid || sub.comped);
    return html`<div class="plan ${current ? 'current' : ''} ${key === 'team' ? 'featured' : ''}" data-plan="${key}">
      <div class="plan-head"><h3>${title}</h3>${current ? html`<span class="pill completed">Current</span>` : key === 'team' ? html`<span class="pill sent">Popular</span>` : ''}</div>
      <div class="price">${price ? html`${dollars(price[interval])}<small>/${interval === 'month' ? 'mo' : 'yr'}</small>` : html`$0`}</div>
      <div class="price-note">${!price ? 'Forever' : interval === 'year' ? `${dollars(Math.round(price.year / 12))}/mo billed yearly · save 15%`
        : discount ? `First month ${dollars(price.month / 2)} · 50% off` : 'Billed monthly'}</div>
      <p class="muted">${blurb}</p>
      <ul class="feat">${features.map((f) => html`<li>${f}</li>`)}</ul>
      ${price && enabled && !sub.comped && !paid ? html`<form method="post" action="/billing/checkout">
        <input type="hidden" name="plan" value="${key}"><input type="hidden" name="interval" value="${interval}">
        <button type="submit" class="block ${key === 'team' ? '' : 'secondary'}">Choose ${title}</button></form>` : ''}
    </div>`;
  };
  return layout('Plan & billing', html`
  ${error ? html`<div class="errors" role="alert">${error}</div>` : ''}
  ${sub.status === 'past_due' ? html`<div class="errors" role="alert">Your last payment didn't go through. Update your card in Manage billing to keep your plan.</div>` : ''}
  <div class="card" id="current-plan">
    <div class="row" style="justify-content:space-between;align-items:flex-start;gap:12px">
      <div><div class="muted" style="font-size:13px">Current plan</div>
        <div style="font-size:24px;font-weight:700;letter-spacing:-.02em" data-k="plan">${PLAN_NAMES[plan]}</div>
        <div class="muted" style="font-size:14px" data-k="usage">${usage}</div></div>
      ${sub.comped ? html`<span class="pill completed">Free for ${org.name}</span>` : ''}
    </div>
    ${paid ? html`<div class="hint" style="margin-top:10px">${sub.cancel_at_period_end ? html`Ends on ${renew}. You'll move to Free after that.` : html`Renews ${renew}, billed ${sub.billing_interval === 'year' ? 'yearly' : 'monthly'}.`}</div>
      <form method="post" action="/billing/portal" style="margin-top:12px"><button type="submit" class="secondary block">${icon('card')}Manage billing</button></form>
      <div class="hint">Change plan, update your card, see receipts or cancel. Handled securely by Stripe.</div>` : ''}
  </div>
  ${!enabled && !sub.comped ? html`<div class="notice">Paid plans aren't available yet. Online billing still needs to be set up for this app.</div>` : ''}
  ${sub.comped ? '' : html`
  <div class="seg" role="tablist">
    <a href="/billing" class="${interval === 'month' ? 'on' : ''}">Monthly</a>
    <a href="/billing?interval=year" class="${interval === 'year' ? 'on' : ''}">Yearly <span class="save">−15%</span></a>
  </div>
  <div class="plans">
    ${card('free', 'Free', 'For running jobs on your own.', ['1 person', 'Clients, estimates & jobs', 'PDF estimates & invoices'])}
    ${card('team', 'Team', 'For a small crew.', ['Up to 3 admins', 'Up to 10 crew members', 'Everything in Free'])}
    ${card('unlimited', 'Unlimited', 'For growing companies.', ['Unlimited admins', 'Unlimited crew', 'Everything in Team'])}
  </div>
  <p class="hint">Cancel anytime; you keep your plan until the end of the period you paid for. If a plan ends, nothing is deleted. You just can't add more people until you upgrade again.${testMode ? ' Test mode: use card 4242 4242 4242 4242.' : ''}</p>`}`,
  { flash, back: { href: '/account', label: 'Account' } });
}

// ---------- Team ----------
function teamPage({ org, members, me, joinCode, plan, errors = {}, values = {}, flash }) {
  const admin = org.role === 'admin';
  const room = admin ? seatsLeft(plan, members) : null;
  return layout('Team', html`
  ${errorBox(errors)}
  ${admin ? html`<a class="card plan-strip" href="/billing">
    <span class="icon-bubble">${icon('card')}</span>
    <div class="main-t"><div class="t">${PLAN_NAMES[plan]} plan</div><div class="s">${room}</div></div>${chev()}</a>` : ''}
  ${admin && joinCode ? html`<div class="card">
    <div class="row" style="justify-content:space-between"><strong>Join code</strong>
      <form method="post" action="/team/code" data-confirm="Make a new code? The current one will stop working.">
        <button type="submit" class="sm ghost">New code</button></form></div>
    <div class="code" id="join-code">${joinCode.slice(0, 4)}-${joinCode.slice(4)}</div>
    <div class="hint">Share this with your crew. After creating an account, they enter it to join ${org.name} as crew.</div>
  </div>` : ''}
  <h2>People</h2>
  <div class="list">${members.map((m) => (admin ? html`<a class="li" href="/team/${m.user_id}">
    <span class="avatar">${initialOf(m)}</span>
    <div class="main-t"><div class="t">${who(m)}${m.user_id === me ? html` <span class="muted">(you)</span>` : ''}</div>
      <div class="s">${ROLES[m.role]} · ${payLabel(m)} · ${m.job_count} job${m.job_count === 1 ? '' : 's'}</div></div>
    <div class="r"><span class="amt">${fmt(m.earned_cents)}</span><span class="muted" style="font-size:12px">paid on completed jobs</span></div>${chev()}
  </a>` : html`<a class="li" href="mailto:${m.email}">
    <span class="avatar">${initialOf(m)}</span>
    <div class="main-t"><div class="t">${who(m)}${m.user_id === me ? html` <span class="muted">(you)</span>` : ''}</div>
      <div class="s">${ROLES[m.role]}${m.full_name ? ` · ${m.email}` : ''}</div></div>
    <span class="icon-bubble">${icon('mail')}</span>
  </a>`))}</div>
  <p class="hint"><strong>Admins</strong> see and manage everything, including money and the team.
    <strong>Crew</strong> see only the jobs assigned to them (dates, address, scope of work and their own pay) and who is on the team.</p>
  ${admin ? html`<form method="post" action="/team/add" class="form-card" novalidate>
    <h3>Add by email</h3>
    <div class="hint">For someone who already has an account.</div>
    ${input('email', 'Email', values, errors, { type: 'email', required: true, inputmode: 'email' })}
    <label for="new-role">Role</label>${roleSelect('role', values.role || 'worker', 'new-role')}
    <div class="form-actions"><button type="submit">Add to ${org.name}</button></div>
  </form>` : ''}`, { flash });
}

function memberPage({ org, member, me, jobs, totals, pay = { pay_type: 'sub' }, errors = {}, flash }) {
  const open = jobs.filter((j) => j.status !== 'completed');
  const done = jobs.filter((j) => j.status === 'completed');
  const rows = (list, empty) => (list.length ? html`<div class="list">${list.map((j) => html`<a class="li" href="/jobs/${j.id}">
    <div class="main-t"><div class="t">${j.project_name}</div>
      <div class="s">${j.client_name}${dateRange(j.start_date, j.end_date) ? ' · ' : ''}${dateRange(j.start_date, j.end_date)}</div></div>
    <div class="r"><span class="amt">${fmt(j.payout_cents)}</span>${pill(j.status, JOB_STATUS)}</div>${chev()}</a>`)}</div>`
    : html`<div class="empty">${empty}</div>`);
  return layout(who(member), html`
  <p style="margin:0 2px 14px"><span class="pill ${member.role === 'admin' ? 'sent' : ''}">${ROLES[member.role]}</span></p>
  ${errorBox(errors)}
  <div class="list" id="contact">
    <a class="li" href="mailto:${member.email}"><span class="icon-bubble">${icon('mail')}</span><div class="main-t"><div class="s">Email</div><div class="t">${member.email}</div></div></a>
    ${member.phone ? html`<a class="li" href="tel:${member.phone}"><span class="icon-bubble">${icon('phone')}</span><div class="main-t"><div class="s">Phone</div><div class="t">${member.phone}</div></div></a>` : ''}
    ${member.zip ? html`<div class="li"><span class="icon-bubble">${icon('pin')}</span><div class="main-t"><div class="s">ZIP code</div><div class="t">${member.zip}</div></div></div>` : ''}
  </div>
  <div class="stats">
    <div class="stat"><div class="k">Jobs completed</div><div class="v" data-k="jobs-done">${done.length}</div></div>
    <div class="stat"><div class="k">Open jobs</div><div class="v" data-k="jobs-open">${open.length}</div></div>
    <div class="stat"><div class="k">Pay on completed jobs</div><div class="v" data-k="earned">${fmt(totals.earned)}</div></div>
    <div class="stat"><div class="k">Pay on open jobs</div><div class="v" data-k="upcoming">${fmt(totals.upcoming)}</div></div>
    <div class="stat wide"><div class="k">Pay this year</div><div class="v" data-k="year">${fmt(totals.year)}</div><div class="s">Completed jobs finished in ${totals.yearLabel}</div></div>
  </div>
  <h2>Open jobs</h2>${rows(open, 'No open jobs assigned.')}
  <h2>Completed jobs</h2>${rows(done, 'No completed jobs yet.')}
  <h2 id="pay">Pay</h2>
  <form method="post" action="/team/${member.user_id}/pay" class="form-card" novalidate>
    <div class="seg pay-type" role="radiogroup" aria-label="How they're paid">
      ${Object.entries(PAY_TYPES).map(([k, l]) => html`<label class="${pay.pay_type === k ? 'on' : ''}"><input type="radio" name="pay_type" value="${k}" ${pay.pay_type === k ? raw('checked') : ''}>${l}</label>`)}
    </div>
    <div class="hint" data-for="sub">Paid a fixed amount per job, set on each job.</div>
    <div class="hint" data-for="w2">Clocks in and out on their jobs from their phone. Hours × hourly rate count as labor on the job automatically.</div>
    <div data-for="w2">${input('hourly_rate', 'Hourly rate ($)', { hourly_rate: pay.hourly_rate_cents != null ? plainCents(pay.hourly_rate_cents) : '' }, {}, { inputmode: 'decimal' })}</div>
    <div class="form-actions"><button type="submit" class="secondary">Save pay</button></div>
  </form>
  <script>${raw(`(function(){var f=document.querySelector('.pay-type').closest('form');function sync(){var v=f.pay_type.value;f.querySelectorAll('[data-for]').forEach(function(e){e.style.display=e.dataset.for===v?'':'none'});
    f.querySelectorAll('.pay-type label').forEach(function(l){l.classList.toggle('on',l.querySelector('input').checked)});}
    f.querySelectorAll('input[name=pay_type]').forEach(function(r){r.addEventListener('change',sync)});sync();})();`)}</script>
  <h2>Role</h2>
  <form method="post" action="/team/role" class="form-card" novalidate>
    <input type="hidden" name="user_id" value="${member.user_id}">
    <label for="role">Role in ${org.name}</label>${roleSelect('role', member.role, 'role')}
    <div class="form-actions"><button type="submit" class="secondary">Save role</button></div>
  </form>
  ${member.user_id !== me ? html`<form method="post" action="/team/remove" data-confirm="Remove ${who(member)} from ${org.name}?">
    <input type="hidden" name="user_id" value="${member.user_id}"><button type="submit" class="danger block">Remove from ${org.name}</button></form>` : ''}`,
  { flash, back: { href: '/team', label: 'Team' } });
}

// ---------- Crew ----------
// Crew see only jobs they're assigned to (from crew_jobs()): dates, address, scope, notes and their own pay.
const crewRow = (j) => html`<a class="li" href="/schedule/${j.job_id}">
  <span class="icon-bubble">${icon('calendar')}</span>
  <div class="main-t"><div class="t">${j.project_name}</div>
    <div class="s">${dateRange(j.start_date, j.end_date) || 'Not scheduled yet'} · ${j.address || j.client_name}</div></div>
  <div class="r">${j.my_payout_cents == null ? '' : html`<span class="amt">${fmt(j.my_payout_cents)}</span>`}${pill(j.status, JOB_STATUS)}</div>
  ${chev()}
</a>`;
const crewList = (list, empty) => (list.length ? html`<div class="list">${list.map(crewRow)}</div>` : html`<div class="empty">${empty}</div>`);
const onDay = (j, d) => j.start_date && j.start_date <= d && (j.end_date || j.start_date) >= d;

function crewHomePage({ jobs, today, year, flash }) {
  const open = jobs.filter((j) => j.status !== 'completed');
  const doneThisYear = jobs.filter((j) => j.status === 'completed' && j.completed_year === year);
  const todays = open.filter((j) => onDay(j, today));
  const next = todays[0] || open.find((j) => j.start_date && j.start_date > today) || open[0];
  const later = open.filter((j) => !todays.includes(j));
  const sum = (list) => list.reduce((t, j) => t + Number(j.my_payout_cents || 0), 0);
  const clocked = jobs.find((j) => j.clocked_in_at);
  return layout('Overview', html`
  ${clocked ? html`<a class="card clock" id="clocked-in" href="/schedule/${clocked.job_id}" style="color:inherit">
    <div><div class="t">You're clocked in</div><div class="s">${clocked.project_name}</div></div><span class="btn danger sm">Clock out</span></a>` : ''}
  <div class="hero" id="next-job">
    <div class="k">${next && onDay(next, today) ? 'Today' : 'Next job'}</div>
    ${next ? html`<a href="/schedule/${next.job_id}" style="color:inherit;display:block">
      <div style="font-size:26px;font-weight:750;letter-spacing:-.02em;margin:4px 0 2px">${next.project_name}</div>
      <div class="s">${dateRange(next.start_date, next.end_date) || 'Not scheduled yet'}${next.address ? ` · ${next.address}` : ''}</div></a>`
    : html`<div style="font-size:22px;font-weight:700;margin:4px 0 2px">Nothing scheduled</div><div class="s">New jobs show here once you're assigned.</div>`}
  </div>
  <div class="stats four">
    <div class="stat"><div class="k">Open jobs</div><div class="v" data-k="open-jobs">${open.length}</div></div>
    <div class="stat"><div class="k">Pay on open jobs</div><div class="v" data-k="upcoming-pay">${fmt(sum(open))}</div></div>
    <div class="stat"><div class="k">Jobs done in ${year}</div><div class="v" data-k="done-year">${doneThisYear.length}</div></div>
    <div class="stat"><div class="k">Pay in ${year}</div><div class="v" data-k="pay-year">${fmt(sum(doneThisYear))}</div><div class="s">From completed jobs</div></div>
  </div>
  ${todays.length ? html`<h2>Today</h2>${crewList(todays, '')}` : ''}
  <h2>Coming up</h2>${crewList(later, 'No other open jobs assigned to you.')}`, { flash, pageTitle: 'Overview' });
}

function crewJobsPage({ jobs, cal, flash }) {
  const [y, m, d] = cal.day.split('-').map(Number);
  const dayName = DOW[new Date(cal.day + 'T00:00:00Z').getUTCDay()];
  const dayJobs = jobs.filter((j) => onDay(j, cal.day));
  const legend = html`<div class="cal-legend"><span><i style="background:var(--amber)"></i>Not started</span><span><i style="background:var(--blue)"></i>In progress</span>
    <span><i style="background:var(--green)"></i>Completed</span></div>`;
  const week = cal.view === 'week';
  return layout('Jobs', html`
  ${viewSwitch('/schedule', week ? 'week' : 'month', cal.day)}
  ${week ? weekView({ day: cal.day, today: cal.today, base: '/schedule',
    items: (dd) => jobs.filter((j) => onDay(j, dd)).map((j) => ({ href: `/schedule/${j.job_id}`, cls: j.status, title: j.project_name, sub: j.address || j.client_name })) })
    : calendar({ ...cal, base: '/schedule' })}
  ${legend}
  ${week ? '' : html`<h2 id="day-jobs">${cal.day === cal.today ? 'Today' : dayName}, ${MONTHS[m - 1]} ${d}${y !== Number(cal.today.slice(0, 4)) ? `, ${y}` : ''}</h2>
  ${crewList(dayJobs, 'Nothing scheduled for you this day.')}`}
  <h2>Open jobs</h2>${crewList(jobs.filter((j) => j.status !== 'completed'), 'No open jobs assigned to you.')}
  <h2>Completed</h2>${crewList(jobs.filter((j) => j.status === 'completed'), 'No completed jobs yet.')}`, { flash, sub: 'Jobs you\'re assigned to' });
}

// Admins can open /schedule too: every open job, with their own pay where they're assigned.
function schedulePage({ jobs, flash }) {
  return layout('Schedule', crewList(jobs, 'No open jobs.'), { flash, sub: 'Open jobs' });
}

function scheduleJobPage({ job, me, photos = [], flash }) {
  const hourly = job.my_pay_type === 'w2';
  return layout(job.project_name, html`
  <p style="margin:0 2px 14px">${pill(job.status, JOB_STATUS)}</p>
  ${job.my_payout_cents == null ? '' : html`<div class="hero"><div class="k">Your pay for this job</div>
    <div class="v" data-k="my-pay">${fmt(job.my_payout_cents)}</div>
    ${hourly ? html`<div class="s" data-k="my-hours">${fmtHours(job.my_minutes)} worked</div>` : ''}</div>`}
  ${hourly && job.my_payout_cents != null && (job.status !== 'completed' || job.clocked_in_at) ? html`<div class="card clock" id="clock">
    <div><div class="t">${job.clocked_in_at ? 'You\'re clocked in' : 'Time clock'}</div>
      <div class="s">${job.clocked_in_at ? html`Since <span data-local-time="${job.clocked_in_at}">${job.clocked_in_at.slice(11, 16)}</span>` : 'Clock in when you start work here.'}</div></div>
    <form method="post" action="/schedule/${job.job_id}/${job.clocked_in_at ? 'clock-out' : 'clock-in'}">
      <button type="submit" class="${job.clocked_in_at ? 'danger' : ''}" id="clock-btn">${job.clocked_in_at ? 'Clock out' : 'Clock in'}</button></form>
  </div>
  <script>${raw(`document.querySelectorAll('[data-local-time]').forEach(function(e){e.textContent=new Date(e.dataset.localTime).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})});`)}</script>` : ''}
  <div class="list">
    <div class="kv"><span class="k">Dates</span><span class="v">${dateRange(job.start_date, job.end_date) || 'Not scheduled yet'}</span></div>
    <div class="kv"><span class="k">Client</span><span class="v">${job.client_name}</span></div>
    <div class="kv"><span class="k">Address</span><span class="v">${job.address ? html`<a href="https://maps.google.com/?q=${encodeURIComponent(job.address)}">${job.address}</a>` : '—'}</span></div>
  </div>
  <h2>Scope of work</h2><div class="card pre">${job.scope || '—'}</div>
  ${job.notes ? html`<h2>Notes</h2><div class="card pre">${job.notes}</div>` : ''}
  ${job.my_payout_cents == null ? '' : html`<h2 id="photos">Photos</h2>${photoSection(job.job_id, photos, (p) => p.uploaded_by === me)}`}`,
  { flash, back: { href: '/schedule', label: 'Jobs' } });
}

// ---------- Home ----------
// Revenue growth: this month so far vs the same days of last month.
function growthBadge(m) {
  if (!m.prevCents) {
    return html`<span class="delta" id="revenue-growth">${m.revenueCents ? 'None by this point last month' : 'No jobs completed yet'}</span>`;
  }
  const pct = ((m.revenueCents - m.prevCents) / m.prevCents) * 100;
  const shown = `${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(Math.abs(pct) < 10 ? 1 : 0)}%`;
  return html`<span class="delta" id="revenue-growth" title="Compared with the ${m.prevLabel}">${pct >= 0 ? "▲" : "▼"} ${shown} vs last month</span>`;
}

// Bar chart of revenue per month (one series, so no legend). Tap or hover a bar to read its value.
function revenueChart(rows) {
  const max = Math.max(...rows.map((r) => r.cents));
  const top = max > 0 ? niceCeil(max) : 100000;
  const last = rows[rows.length - 1];
  return html`<section class="chart" id="revenue-chart">
    <div class="chart-head"><h2>Revenue by month</h2>
      <div class="chart-read" aria-live="polite"><strong>${fmt(last.cents)}</strong><span>${last.long_label}</span></div></div>
    <div class="chart-plot">
      <span class="chart-max">${fmtShort(top)}</span><span class="chart-mid">${fmtShort(top / 2)}</span>
      <div class="bars">${rows.map((r, i) => html`<button type="button" class="bar-col${i === rows.length - 1 ? ' on' : ''}" data-v="${fmt(r.cents)}" data-l="${r.long_label}" aria-label="${r.long_label}: ${fmt(r.cents)}">
        <span class="bar-area"><span class="bar" style="height:${r.cents ? Math.max(2, (r.cents / top) * 100).toFixed(1) : 0}%"></span></span><span class="bar-l">${r.label}</span></button>`)}</div>
    </div>
    <table class="sr-only"><caption>Revenue by month</caption><tbody>${rows.map((r) => html`<tr><th scope="row">${r.long_label}</th><td>${fmt(r.cents)}</td></tr>`)}</tbody></table>
    <script>${raw(`(function(){var c=document.getElementById('revenue-chart');var s=c.querySelector('.chart-read');
      function show(b){c.querySelectorAll('.bar-col.on').forEach(function(x){x.classList.remove('on')});b.classList.add('on');
        s.querySelector('strong').textContent=b.dataset.v;s.querySelector('span').textContent=b.dataset.l;}
      c.querySelectorAll('.bar-col').forEach(function(b){b.addEventListener('click',function(){show(b)});b.addEventListener('mouseenter',function(){show(b)});b.addEventListener('focus',function(){show(b)});});})();`)}</script>
  </section>`;
}
// Rounds up to 1, 2, 2.5 or 5 times a power of ten, so the gridlines land on round dollars.
function niceCeil(cents) {
  const p = 10 ** Math.floor(Math.log10(cents));
  return [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map((k) => k * p).find((v) => v >= cents);
}
function fmtShort(cents) {
  const d = cents / 100;
  if (d >= 1e6) return `$${+(d / 1e6).toFixed(1)}M`;
  if (d >= 1e3) return `$${+(d / 1e3).toFixed(d >= 1e4 ? 0 : 1)}k`;
  return `$${Math.round(d)}`;
}

function homePage({ openEstimates, activeJobs, outstandingCents, month, revenueByMonth, flash }) {
  const profitClass = month.profitCents > 0 ? 'good' : month.profitCents < 0 ? 'bad' : '';
  return layout('Home', html`
  <div class="hero">
    <div class="hero-top"><div class="k">Revenue · ${month.label}</div>${growthBadge(month)}</div>
    <div class="v" id="month-revenue">${fmt(month.revenueCents)}</div>
    <div class="s">Value of jobs completed this month</div>
  </div>
  <div class="stats four">
    <div class="stat wide-sm ${profitClass}"><div class="k">Gross profit · ${month.label}</div><div class="v" id="month-profit">${fmt(month.profitCents)}</div>
      <div class="s">${month.completedJobs ? `From ${month.completedJobs} job${month.completedJobs > 1 ? 's' : ''} completed this month` : 'No jobs completed this month yet'}</div></div>
    <div class="stat wide-sm"><div class="k">Outstanding</div><div class="v" id="total-outstanding">${fmt(outstandingCents)}</div><div class="s">Completed jobs, minus payments received</div></div>
    <div class="stat"><div class="k">Active jobs</div><div class="v">${activeJobs.length}</div></div>
    <div class="stat"><div class="k">Open estimates</div><div class="v">${openEstimates.length}</div></div>
  </div>
  <div class="actions">
    <a class="btn secondary" href="/clients/new">${icon('plus')}New Client</a>
    <a class="btn" href="/estimates/new">${icon('plus')}New Estimate</a>
  </div>
  ${revenueByMonth?.length ? revenueChart(revenueByMonth) : ''}
  <h2>Active jobs</h2>${jobList(activeJobs, 'No active jobs.')}
  <h2>Open estimates</h2>${estimateList(openEstimates, 'No open estimates.')}`, { flash, pageTitle: 'Overview' });
}

function estimateList(rows, empty, { showClient = true } = {}) {
  if (!rows.length) return html`<div class="empty">${empty}</div>`;
  return html`<div class="list">${rows.map((e) => html`<a class="li" href="/estimates/${e.id}">
    <div class="main-t"><div class="t">${e.project_name}</div>
      <div class="s">${showClient ? e.client_name : `Updated ${e.updated_at.slice(0, 10)}`}${e.job_id ? ' · converted to job' : ''}</div></div>
    <div class="r"><span class="amt">${fmt(e.total_cents)}</span>${pill(e.status, ESTIMATE_STATUS)}</div>${chev()}
  </a>`)}</div>`;
}

function jobList(rows, empty, { showClient = true } = {}) {
  if (!rows.length) return html`<div class="empty">${empty}</div>`;
  return html`<div class="list">${rows.map((j) => html`<a class="li" href="/jobs/${j.id}">
    <div class="main-t"><div class="t">${j.project_name}</div>
      <div class="s">${showClient ? j.client_name : ''}${showClient && (j.start_date || j.end_date) ? ' · ' : ''}${dateRange(j.start_date, j.end_date)}</div></div>
    <div class="r"><span class="amt">${fmt(j.balance_cents)}</span>${pill(j.status, JOB_STATUS)}</div>${chev()}
  </a>`)}</div>`;
}

// ---------- Clients ----------
function clientsPage({ clients, q, flash }) {
  return layout('Clients', html`
  <form method="get" action="/clients" class="search" role="search">
    ${icon('search')}<input name="q" type="search" value="${q}" placeholder="Search by name" aria-label="Search by name">
  </form>
  ${q ? '' : html`<p class="hint" style="margin:0 4px 12px"><a href="/import" id="import-link">Import clients or jobs from another app</a></p>`}
  ${clients.length ? html`<div class="list">${clients.map((c) => html`<a class="li" href="/clients/${c.id}">
    <span class="avatar">${c.name[0].toUpperCase()}</span>
    <div class="main-t"><div class="t">${c.name}</div><div class="s">${c.address || c.phone || c.email || ' '}</div></div>
    ${c.value_cents ? html`<div class="r"><span class="amt">${fmt(c.value_cents)}</span></div>` : ''}${chev()}
  </a>`)}</div>` : html`<div class="empty">${q ? 'No clients match that name.' : 'No clients yet.'}</div>`}`,
  { fab: { href: '/clients/new', label: 'New Client' }, flash });
}

function clientFields(values, errors, prefix = '') {
  const v = {}; const er = {};
  for (const k of ['name', 'phone', 'email', 'address']) { v[prefix + k] = values[prefix + k]; er[prefix + k] = errors[prefix + k]; }
  return html`
    ${input(prefix + 'name', 'Name', v, er, { required: true, autocomplete: 'off' })}
    <div class="two stack"><div>${input(prefix + 'phone', 'Phone', v, er, { type: 'tel', inputmode: 'tel' })}</div>
    <div>${input(prefix + 'email', 'Email', v, er, { type: 'email', inputmode: 'email' })}</div></div>
    ${input(prefix + 'address', 'Property address', v, er)}
    <label class="check"><input type="checkbox" name="${prefix}sms_consent" ${values[prefix + 'sms_consent'] ? raw('checked') : ''}>
      <span>OK to text<div class="hint" style="font-weight:400;margin:2px 0 0">The client agreed to get texts from you, like reminders and follow-ups. They can reply STOP any time.</div></span></label>
    ${values[prefix + 'sms_opted_out_at'] ? html`<div class="hint">This client replied STOP, so they won't get texts unless they reply START.</div>` : ''}`;
}

function clientFormPage({ client, values, errors = {} }) {
  const cancel = client ? `/clients/${client.id}` : '/clients';
  return layout(client ? 'Edit client' : 'New client', html`
  ${errorBox(errors)}
  <form method="post" action="${client ? `/clients/${client.id}` : '/clients'}" novalidate>
    <div class="form-card">${clientFields(values, errors)}</div>
    <div class="form-actions"><a class="btn secondary" href="${cancel}">Cancel</a><button type="submit">Save client</button></div>
  </form>`, { back: { href: cancel, label: client ? client.name : 'Clients' } });
}

function clientPage({ client, estimates, jobs, flash }) {
  const value = jobs.reduce((a, j) => a + j.contract_cents, 0);
  const paid = jobs.reduce((a, j) => a + j.payments_cents, 0);
  const pipeline = estimates.filter((e) => !e.job_id && ['draft', 'sent'].includes(e.status)).reduce((a, e) => a + e.total_cents, 0);
  return layout(client.name, html`
  <div class="stats" id="client-value">
    <div class="stat wide"><div class="k">Total value</div><div class="v" data-k="client-value">${fmt(value)}</div>
      <div class="s">${jobs.length} job${jobs.length === 1 ? '' : 's'}</div></div>
    <div class="stat"><div class="k">Paid</div><div class="v" data-k="client-paid">${fmt(paid)}</div></div>
    <div class="stat"><div class="k">Outstanding</div><div class="v" data-k="client-owed">${fmt(value - paid)}</div></div>
    ${pipeline ? html`<div class="stat wide"><div class="k">Open estimates</div><div class="v" data-k="client-pipeline">${fmt(pipeline)}</div></div>` : ''}
  </div>
  <div class="list">
    ${client.phone ? html`<a class="li" href="tel:${client.phone}"><span class="icon-bubble">${icon('phone')}</span><div class="main-t"><div class="s">Phone</div><div class="t">${client.phone}</div></div></a>` : ''}
    ${client.email ? html`<a class="li" href="mailto:${client.email}"><span class="icon-bubble">${icon('mail')}</span><div class="main-t"><div class="s">Email</div><div class="t">${client.email}</div></div></a>` : ''}
    ${client.address ? html`<a class="li" href="https://maps.google.com/?q=${encodeURIComponent(client.address)}"><span class="icon-bubble">${icon('pin')}</span><div class="main-t"><div class="s">Property address</div><div class="t">${client.address}</div></div></a>` : ''}
    ${!client.phone && !client.email && !client.address ? html`<div class="li muted">No contact details yet.</div>` : ''}
  </div>
  <div class="actions">
    <a class="btn" href="/estimates/new?client_id=${client.id}">${icon('plus')}New Estimate</a>
    <a class="btn secondary" href="/clients/${client.id}/edit">Edit client</a>
    <a class="btn danger" href="/clients/${client.id}/delete">Delete</a>
  </div>
  <h2>Estimates</h2>${estimateList(estimates, 'No estimates for this client.', { showClient: false })}
  <h2>Jobs</h2>${jobList(jobs, 'No jobs for this client.', { showClient: false })}`,
  { flash, back: { href: '/clients', label: 'Clients' } });
}

// ---------- Estimates ----------
function chips(base, labels, status) {
  return html`<div class="chips">${[['', 'All'], ...Object.entries(labels)].map(([k, label]) =>
    html`<a class="chip ${k === status ? 'on' : ''}" href="${base}${k ? `?status=${k}` : ''}">${label}</a>`)}</div>`;
}

function estimatesPage({ estimates, status }) {
  return layout('Estimates', html`${chips('/estimates', ESTIMATE_STATUS, status)}${estimateList(estimates, 'No estimates.')}`,
    { fab: { href: '/estimates/new', label: 'New Estimate' } });
}

function estimateFormPage({ estimate, values, items, errors = {}, clients }) {
  const action = estimate ? `/estimates/${estimate.id}` : '/estimates';
  // Always offer blank rows so the form works without JavaScript too.
  const all = [...items, ...Array.from({ length: items.length ? 1 : 2 }, () => ({ desc: '', details: '', qty: '', price: '', option: '' }))];
  const isNewClient = values.client_id === 'new' || (!values.client_id && !clients.length);
  const cancel = estimate ? `/estimates/${estimate.id}` : '/estimates';
  return layout(estimate ? 'Edit estimate' : 'New estimate', html`
  ${errorBox(errors)}
  <form method="post" action="${action}" id="estimate-form" novalidate>
    <div class="form-card">
      <label for="client_id">Client *</label>
      <select id="client_id" name="client_id" class="${inv(errors, 'client_id')}">
        <option value="">Choose a client…</option>
        <option value="new" ${isNewClient ? raw('selected') : ''}>+ New client</option>
        ${clients.map((c) => html`<option value="${c.id}" ${String(values.client_id) === String(c.id) ? raw('selected') : ''}>${c.name}</option>`)}
      </select>${fieldErr(errors, 'client_id')}
      <div id="new-client" style="${isNewClient ? '' : 'display:none'}">${clientFields(values, errors, 'new_')}</div>
    </div>
    <div class="form-card">
      ${input('address', 'Job address', values, errors, { autocomplete: 'street-address', hint: "This is also the project's name. Leave blank to use the client's address." })}
      <div class="two">
        <div>${input('visit_date', 'Estimate date', values, errors, { type: 'date' })}</div>
        <div>${input('visit_time', 'Time', values, errors, { type: 'time' })}</div>
      </div>
      <div class="hint">Optional. Puts the estimate on your calendar.</div>
      <label for="status">Status</label>
      <select id="status" name="status">${options(ESTIMATE_STATUS, values.status)}</select>
    </div>
    <h2>Line items</h2>
    ${errors.items ? html`<div class="field-error" style="margin:0 4px 8px">${errors.items}</div>` : ''}
    ${errors.options ? html`<div class="field-error" style="margin:0 4px 8px">${errors.options}</div>` : ''}
    <p class="hint" style="margin:0 4px 8px">Want to offer choices? Put an option name like <strong>Good</strong>, <strong>Better</strong> or <strong>Best</strong> on lines;
      the client picks one when approving. Lines with no option are included in every choice.
      Names and descriptions become the job's scope of work, and you can edit them any time.</p>
    <datalist id="option-names"><option value="Good"><option value="Better"><option value="Best"></datalist>
    <div class="form-card" style="padding-top:6px">
      <div id="items">${all.map((it, i) => itemRow(it, errors[`item_${i}`]))}</div>
      <button type="button" class="secondary block" id="add-item" style="margin-top:12px">${icon('plus')}Add line item</button>
    </div>
    <div class="form-card">
      ${input('estimated_cost', 'Internal estimated cost ($)', values, errors, { inputmode: 'decimal', placeholder: '0.00',
        hint: 'Your expected cost for the whole project. Never shown to the client.' })}
      <div class="row" style="justify-content:space-between;margin-top:14px"><span class="muted">Estimated profit</span><strong id="calc-profit">—</strong></div>
      <div id="calc-options" class="hint" style="margin-top:6px"></div>
    </div>
    <div class="form-card">
      ${input('deposit_percent', 'Deposit due at approval (%)', values, errors, { inputmode: 'numeric', placeholder: '0',
        hint: 'When the client approves online, they get an invoice for this share of the total. 0 for no deposit.' })}
    </div>
    <div class="totalbar">
      <div class="grow"><div class="lbl">Estimate total</div><div class="num" id="calc-total">—</div></div>
      <a class="btn ghost" href="${cancel}" style="color:inherit;opacity:.8">Cancel</a>
      <button type="submit">Save estimate</button>
    </div>
  </form>
  <template id="item-template">${itemRow({ desc: '', details: '', qty: '', price: '', option: '' })}</template>
  <script>${raw(ESTIMATE_JS)}</script>`, { back: { href: cancel, label: estimate ? estimate.project_name : 'Estimates' } });
}

function descriptionsPage({ estimate, items, job, errors = {}, values = {} }) {
  const back = job ? { href: `/jobs/${job.id}`, label: 'Job' } : { href: `/estimates/${estimate.id}`, label: 'Estimate' };
  return layout('Line item descriptions', html`
  ${errorBox(errors)}
  <form method="post" action="/estimates/${estimate.id}/descriptions" novalidate id="descriptions-form">
    ${items.map((it, n) => { const v = values[it.id] || { name: it.description, details: it.details }; return html`<div class="form-card">
      <div class="row" style="justify-content:space-between"><strong>Line ${n + 1}${it.option_name ? ` · ${it.option_name}` : ''}</strong>
        <span class="muted">${fmtQty(it.qty_hundredths)} × ${fmt(it.unit_price_cents)}</span></div>
      <label for="name_${it.id}">Name *</label>
      <input id="name_${it.id}" name="name_${it.id}" value="${v.name}" class="${errors[`item_${it.id}`] ? 'invalid' : ''}">
      <label for="details_${it.id}">Description</label>
      <textarea id="details_${it.id}" name="details_${it.id}" rows="6" style="min-height:140px">${v.details}</textarea>
    </div>`; })}
    <p class="hint">${job ? 'Prices and quantities are locked because this estimate is a job. ' : ''}Saving updates the scope of work${job ? ' on the job and its work orders' : ''}.</p>
    <div class="form-actions"><a class="btn secondary" href="${back.href}">Cancel</a><button type="submit">Save descriptions</button></div>
  </form>`, { back, sub: estimate.project_name });
}

function itemRow(it, err) {
  return html`<div class="item">
    <input name="item_desc" value="${it.desc}" aria-label="Line item name" placeholder="Name, e.g. Interior painting" class="${err ? 'invalid' : ''}">
    <textarea name="item_details" aria-label="Description" placeholder="Description: the work included, materials, rooms…" rows="4" class="item-details">${it.details || ''}</textarea>
    ${err ? html`<div class="field-error">${err}</div>` : ''}
    <div class="grid">
      <input name="item_qty" value="${it.qty}" inputmode="decimal" aria-label="Quantity" placeholder="Qty">
      <input name="item_price" value="${it.price}" inputmode="decimal" aria-label="Unit price" placeholder="Unit price">
    </div>
    <input name="item_option" value="${it.option || ''}" list="option-names" aria-label="Option" placeholder="Option (optional)" class="opt-input">
    <div class="foot"><button type="button" class="link remove-item">Remove</button><span>Line total <span class="line-total">—</span></span></div>
  </div>`;
}

// Client-side preview of totals, using integer cents like the server.
const ESTIMATE_JS = `
(function () {
  var list = document.getElementById('items');
  function cents(s) {
    s = String(s || '').replace(/[$,\\s]/g, '');
    if (!/^\\d+(\\.\\d{1,2})?$/.test(s)) return null;
    var p = s.split('.'); return Number(p[0]) * 100 + Number((p[1] || '').padEnd(2, '0'));
  }
  function fmt(c) {
    var neg = c < 0; c = Math.abs(c);
    return (neg ? '-' : '') + '$' + Math.floor(c / 100).toString().replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',') + '.' + String(c % 100).padStart(2, '0');
  }
  function recalc() {
    var shared = 0, opts = {}, order = [];
    list.querySelectorAll('.item').forEach(function (row) {
      var q = cents(row.querySelector('[name=item_qty]').value), p = cents(row.querySelector('[name=item_price]').value);
      var o = row.querySelector('[name=item_option]').value.trim();
      var cell = row.querySelector('.line-total');
      if (q === null || p === null) { cell.textContent = '—'; return; }
      var lt = Math.floor((q * p + 50) / 100); cell.textContent = fmt(lt);
      if (!o) shared += lt; else { if (!(o in opts)) { opts[o] = 0; order.push(o); } opts[o] += lt; }
    });
    // With options, the total shown is the first option's; the client's choice decides the final total.
    var total = shared + (order.length ? opts[order[0]] : 0);
    document.getElementById('calc-total').textContent = fmt(total);
    document.getElementById('calc-options').textContent = order.length
      ? 'Options: ' + order.map(function (o) { return o + ' ' + fmt(shared + opts[o]); }).join(' · ') + '. Profit shown for ' + order[0] + '.' : '';
    var cost = cents(document.getElementById('estimated_cost').value);
    document.getElementById('calc-profit').textContent = cost === null ? 'Enter a cost' : fmt(total - cost);
  }
  document.getElementById('add-item').addEventListener('click', function () {
    list.insertAdjacentHTML('beforeend', document.getElementById('item-template').innerHTML);
    list.lastElementChild.querySelector('input').focus();
  });
  list.addEventListener('click', function (e) {
    if (!e.target.classList.contains('remove-item')) return;
    var row = e.target.closest('.item');
    var filled = Array.prototype.some.call(row.querySelectorAll('input'), function (i) { return i.value.trim(); });
    if (filled && !confirm('Remove this line item?')) return;
    row.remove(); recalc();
  });
  document.getElementById('estimate-form').addEventListener('input', recalc);
  var sel = document.getElementById('client_id');
  sel.addEventListener('change', function () { document.getElementById('new-client').style.display = sel.value === 'new' ? '' : 'none'; });
  recalc();
})();`;

// Timestamps in the company's time zone, e.g. "Oct 20, 3:04 PM".
const fmtWhen = (ts) => (ts ? new Intl.DateTimeFormat('en-US', { timeZone: process.env.APP_TIMEZONE || 'America/Los_Angeles',
  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(ts)) : '');
const EMAIL_KINDS = { estimate: 'Estimate sent', estimate_reminder: 'Follow-up', appointment_reminder: 'Appointment reminder',
  review_request: 'Review request', estimate_approved: 'Approval notice to you', estimate_declined: 'Decline notice to you' };
function emailHistory(emails) {
  if (!emails?.length) return '';
  return html`<h2>Messages</h2><div class="list" id="email-history">${emails.map((m) => html`<div class="li">
    <span class="icon-bubble">${icon(m.channel === 'sms' ? 'phone' : 'mail')}</span>
    <div class="main-t"><div class="t">${EMAIL_KINDS[m.kind] || m.kind}${m.channel === 'sms' ? ' (text)' : ''}</div><div class="s">${m.to_email} · ${fmtWhen(m.created_at)}</div></div>
    ${m.status === 'failed' ? html`<span class="pill declined" title="${m.error}">Failed</span>` : html`<span class="pill completed">Sent</span>`}</div>`)}</div>`;
}

// Line items grouped by option (shared lines first). Used on the company's page and the client's page.
function itemGroups(items) {
  const shared = items.filter((i) => !i.option_name);
  const names = [...new Set(items.filter((i) => i.option_name).map((i) => i.option_name))];
  return { shared, groups: names.map((name) => ({ name, items: items.filter((i) => i.option_name === name) })) };
}
const itemRows = (list) => list.map((i) => html`<tr><td><strong style="font-weight:600">${i.description}</strong>${i.details ? html`<div class="li-details">${i.details}</div>` : ''}
  <div class="muted" style="font-size:13px">${fmtQty(i.qty_hundredths)} × ${fmt(i.unit_price_cents)}</div></td>
  <td class="num">${fmt(i.line_total_cents)}</td></tr>`);

function estimatePage({ estimate, client, items, totalCents, job, options = [], emails = [], sending = {}, sendForm, flash, errors }) {
  const locked = !!job;
  const profit = estimate.estimated_cost_cents == null ? null : totalCents - estimate.estimated_cost_cents;
  const others = Object.entries(ESTIMATE_STATUS).filter(([k]) => k !== estimate.status);
  const { shared, groups } = itemGroups(items);
  const sf = sendForm || { values: { send_to: estimate.sent_to || client.email || '', send_message: '' }, errors: {} };
  const link = `/e/${estimate.public_token}`;
  const chosen = estimate.chosen_option;
  return layout(estimate.project_name, html`
  <p style="margin:0 2px 14px">${pill(estimate.status, ESTIMATE_STATUS)}${chosen ? html` <span class="pill">${chosen}</span>` : ''}</p>
  ${errorBox({ ...errors, ...sf.errors })}
  ${locked ? html`<div class="notice">Converted to <a href="/jobs/${job.id}">a job</a>. This estimate is locked and can no longer be edited.</div>` : ''}
  <div class="stats three">
    <div class="stat wide"><div class="k">${options.length && !chosen ? `Estimate total (${options[0].name})` : 'Estimate total'}</div><div class="v" data-k="estimate-total">${fmt(totalCents)}</div>
      ${options.length && !chosen ? html`<div class="s">${options.map((o) => `${o.name} ${fmt(o.total)}`).join(' · ')}</div>` : ''}</div>
    <div class="stat"><div class="k">Estimated cost</div><div class="v">${fmt(estimate.estimated_cost_cents)}</div></div>
    <div class="stat ${profit == null ? '' : profit >= 0 ? 'good' : 'bad'}"><div class="k">Estimated profit</div><div class="v" id="estimated-profit">${profit == null ? '—' : fmt(profit)}</div></div>
  </div>
  ${estimate.approved_at ? html`<div class="card" id="approval">
    <div class="row" style="gap:10px"><span class="icon-bubble" style="background:var(--green-soft);color:var(--green)">${icon('check')}</span>
      <div><strong>Approved online by ${estimate.signer_name}</strong><div class="muted" style="font-size:14px">${fmtWhen(estimate.approved_at)}${estimate.signer_ip ? ` · IP ${estimate.signer_ip}` : ''}</div></div></div>
    ${estimate.signature ? html`<img src="${estimate.signature}" alt="Client signature" class="sig-img">` : html`<div class="sig-typed">${estimate.signer_name}</div>`}
  </div>` : ''}
  ${estimate.status === 'declined' && estimate.decline_reason ? html`<div class="card"><strong>Client declined</strong><div class="pre muted" style="margin-top:6px">${estimate.decline_reason}</div></div>` : ''}
  ${locked ? '' : html`<div class="card" id="send-card">
    <h3 style="margin:0 0 4px">Send to client</h3>
    <div class="hint" style="margin:0 0 10px">They get a link to review the estimate${options.length ? ', pick an option' : ''}, sign and approve${estimate.deposit_percent ? `, then pay a ${estimate.deposit_percent}% deposit` : ''}. Approving turns it into a job automatically.</div>
    ${estimate.sent_at ? html`<div class="track" id="tracking">Sent to ${estimate.sent_to} · ${fmtWhen(estimate.sent_at)}${estimate.viewed_at ? html` · <strong>Opened ${fmtWhen(estimate.viewed_at)}</strong>` : ' · Not opened yet'}${estimate.reminders_sent ? ` · ${estimate.reminders_sent} follow-up${estimate.reminders_sent > 1 ? 's' : ''} sent` : ''}</div>` : ''}
    ${sending.enabled ? html`<form method="post" action="/estimates/${estimate.id}/send" novalidate>
      ${input('send_to', "Client's email", sf.values, sf.errors, { type: 'email', inputmode: 'email' })}
      ${textarea('send_message', 'Message (optional)', sf.values, {}, { placeholder: `Thanks for the opportunity. Here's your estimate for ${estimate.project_name}.` })}
      <div class="form-actions"><button type="submit" id="send-estimate">${icon('mail')}${estimate.sent_at ? 'Send again' : 'Email estimate'}</button></div>
    </form>` : html`<div class="hint">Emailing isn't set up for this app yet. Copy the link below and text or email it yourself.</div>`}
    <label for="client-link" style="margin-top:12px">Client link</label>
    <div class="row" style="gap:8px;flex-wrap:nowrap"><input id="client-link" readonly value="${link}" data-path="${link}" style="flex:1;min-width:0">
      <button type="button" class="secondary sm" id="copy-link">Copy</button></div>
    <div class="hint"><a href="${link}?preview=1" target="_blank" rel="noopener">Preview what the client sees</a></div>
  </div>
  <div class="card">
    ${estimate.status === 'approved' ? html`
    <form method="post" action="/estimates/${estimate.id}/convert" data-confirm="Convert this estimate to a job? The estimate will be locked.">
      <button type="submit" id="convert" class="block">${icon('briefcase')}Convert to job</button>
    </form>` : html`<div class="hint" style="margin:0 0 10px">Approved in person or by phone? Mark it approved, then convert it to a job.</div>`}
    <div class="row" style="margin-top:12px">${others.map(([k, l]) => html`<form method="post" action="/estimates/${estimate.id}/status" class="row" style="gap:6px">
      <input type="hidden" name="status" value="${k}">
      ${k === 'approved' && options.length ? html`<select name="chosen_option" aria-label="Approved option" style="width:auto">${options.map((o) => html`<option value="${o.name}">${o.name} (${fmt(o.total)})</option>`)}</select>` : ''}
      <button type="submit" class="sm secondary">Mark ${l.toLowerCase()}</button></form>`)}</div>
  </div>`}
  <h2>Client</h2>
  <div class="list"><a class="li" href="/clients/${client.id}"><span class="avatar">${client.name[0].toUpperCase()}</span>
    <div class="main-t"><div class="t">${client.name}</div><div class="s">${client.phone || client.email || ''}</div></div>${chev()}</a>
    ${estimate.address ? html`<a class="li" href="https://maps.google.com/?q=${encodeURIComponent(estimate.address)}"><span class="icon-bubble">${icon('pin')}</span><div class="main-t"><div class="s">Job address</div><div class="t">${estimate.address}</div></div></a>` : ''}
    ${estimate.visit_date ? html`<a class="li" href="/jobs?day=${estimate.visit_date}"><span class="icon-bubble">${icon('calendar')}</span><div class="main-t"><div class="s">Estimate</div><div class="t" id="appointment">${fmtDate(estimate.visit_date)}${estimate.visit_time ? ` at ${fmtTime(estimate.visit_time)}` : ''}</div></div>${chev()}</a>` : ''}
  </div>
  <h2>Line items</h2>
  <div class="card flush"><table class="lines">
    ${groups.length && shared.length ? html`<tbody><tr class="grp"><td colspan="2">Included in every option</td></tr></tbody>` : ''}
    <tbody>${itemRows(shared)}</tbody>
    ${groups.map((g) => html`<tbody class="${chosen && chosen !== g.name ? 'not-chosen' : ''}"><tr class="grp"><td>Option: ${g.name}${chosen === g.name ? ' ✓' : ''}</td>
      <td class="num">${fmt((options.find((o) => o.name === g.name) || {}).total)}</td></tr>${itemRows(g.items)}</tbody>`)}
    <tfoot><tr><td>Total${groups.length ? ` (${chosen || groups[0].name})` : ''}</td><td class="num" id="estimate-total">${fmt(totalCents)}</td></tr></tfoot>
  </table></div>
  ${estimate.deposit_percent ? html`<p class="hint">Deposit at approval: ${estimate.deposit_percent}% (${fmt(Math.round((totalCents * estimate.deposit_percent) / 100))}).</p>` : ''}
  <div class="actions">
    <a class="btn" href="/estimates/${estimate.id}/pdf" id="estimate-pdf">${icon('download')}Download PDF</a>
    ${locked ? html`<a class="btn secondary" href="/estimates/${estimate.id}/descriptions" id="edit-descriptions">Edit descriptions</a>` : html`<a class="btn secondary" href="/estimates/${estimate.id}/edit">Edit estimate</a>
    <a class="btn danger" href="/estimates/${estimate.id}/delete">Delete</a>`}</div>
  ${emailHistory(emails)}
  <p class="hint">The PDF and the client's page show your company profile, the client and line items. Your internal cost and profit are never included.</p>
  <script>${raw(COPY_LINK_JS)}</script>`,
  { flash, back: { href: '/estimates', label: 'Estimates' } });
}
const COPY_LINK_JS = `
(function () {
  var i = document.getElementById('client-link'), b = document.getElementById('copy-link');
  if (!i || !b) return;
  i.value = location.origin + i.dataset.path;
  b.addEventListener('click', function () {
    i.select();
    (navigator.clipboard ? navigator.clipboard.writeText(i.value) : Promise.reject()).catch(function () { document.execCommand('copy'); });
    b.textContent = 'Copied';
    setTimeout(function () { b.textContent = 'Copy'; }, 1500);
  });
})();`;

// ---------- The client's estimate page (opened from the emailed link, no login) ----------
function publicEstimatePage({ estimate, company, hasLogo, client, items, totals, job, invoices = [], canPayOnline, token, values = {}, errors = {}, flash, preview }) {
  const approved = !!job || estimate.status === 'approved';
  const open = !approved;
  const { shared, groups } = itemGroups(items);
  const chosen = estimate.chosen_option;
  const pick = values.option || chosen || '';
  const depositFor = (t) => Math.round((t * estimate.deposit_percent) / 100);
  const base = `/e/${token}`;
  const contact = [company.phone, company.email].filter(Boolean).join(' · ');
  const openInv = invoices.filter((i) => i.status === 'open' && i.hosted_url);
  const paidInv = invoices.filter((i) => i.status === 'paid');
  return layout(estimate.project_name, html`<div class="pub">
  ${preview ? html`<div class="notice">Preview: this is what your client sees. Approving is turned off here.</div>` : ''}
  <header class="pub-head">
    ${hasLogo ? html`<img src="${base}/logo" alt="${company.name}" class="pub-logo">` : html`<div class="mark">${company.name.slice(0, 2).toUpperCase()}</div>`}
    <div><div class="pub-co">${company.name}</div><div class="muted" style="font-size:14px">${contact}${company.license_number ? ` · License #${company.license_number}` : ''}</div></div>
  </header>
  <div class="card">
    <div class="muted" style="font-size:13px;letter-spacing:.04em;text-transform:uppercase">Estimate E-${estimate.id}</div>
    <h1 class="pub-title">${estimate.project_name}</h1>
    <div class="muted">Prepared for <strong style="color:var(--text)">${client.name}</strong>${estimate.address || client.address ? ` · ${estimate.address || client.address}` : ''}</div>
  </div>
  ${approved ? html`<div class="card pub-ok" id="approved">
    <div class="row" style="gap:10px"><span class="icon-bubble" style="background:var(--green-soft);color:var(--green)">${icon('check')}</span>
      <div><strong>Approved${estimate.signer_name ? ` by ${estimate.signer_name}` : ''}</strong>
      <div class="muted" style="font-size:14px">${estimate.approved_at ? fmtWhen(estimate.approved_at) : ''}${chosen ? ` · ${chosen}` : ''} · ${fmt(totals.total)}</div></div></div>
    ${openInv.map((i) => html`<a class="btn block" style="margin-top:14px" href="${i.hosted_url}" id="pay-deposit">${icon('card')}Pay ${i.description.toLowerCase().startsWith('deposit') ? 'deposit' : 'invoice'} · ${fmt(i.amount_cents)}</a>`)}
    ${paidInv.map((i) => html`<div class="hint" style="margin-top:10px">${icon('check')} ${i.description}: ${fmt(i.amount_cents)} paid. Thank you!</div>`)}
    <div class="hint" style="margin-top:10px">${company.name} will be in touch to schedule the work.</div>
  </div>` : ''}
  ${estimate.status === 'declined' && open ? html`<div class="notice">You declined this estimate. Changed your mind? You can still approve it below.</div>` : ''}
  <form method="post" action="${base}/approve" id="approve-form" novalidate>
  ${groups.length ? html`
    ${shared.length ? html`<h2>Included in every option</h2><div class="card flush"><table class="lines"><tbody>${itemRows(shared)}</tbody></table></div>` : ''}
    <h2>${open ? 'Choose an option' : 'Options'}</h2>
    ${errors.option ? html`<div class="field-error" style="margin:0 4px 8px">${errors.option}</div>` : ''}
    <div class="opts">${groups.map((g) => {
      const t = totals.options.find((o) => o.name === g.name).total;
      const isChosen = approved ? chosen === g.name : pick === g.name;
      return html`<label class="opt ${isChosen ? 'on' : ''} ${approved && !isChosen ? 'dim' : ''}">
        ${open ? html`<input type="radio" name="option" value="${g.name}" ${isChosen ? raw('checked') : ''}>` : ''}
        <div class="opt-head"><strong>${g.name}</strong><span class="opt-total">${fmt(t)}</span></div>
        <ul>${g.items.map((i) => html`<li>${i.description}${Number(i.qty_hundredths) !== 100 ? html` <span class="muted">× ${fmtQty(i.qty_hundredths)}</span>` : ''}
          ${i.details ? html`<div class="li-details">${i.details}</div>` : ''}</li>`)}</ul>
        ${estimate.deposit_percent ? html`<div class="muted" style="font-size:13px">${estimate.deposit_percent}% deposit: ${fmt(depositFor(t))}</div>` : ''}
      </label>`;
    })}</div>` : html`
    <h2>Details</h2>
    <div class="card flush"><table class="lines"><tbody>${itemRows(shared)}</tbody>
      <tfoot><tr><td>Total</td><td class="num" data-k="total">${fmt(totals.total)}</td></tr></tfoot></table></div>
    ${estimate.deposit_percent ? html`<p class="hint">A ${estimate.deposit_percent}% deposit (${fmt(depositFor(totals.total))}) is due when you approve.</p>` : ''}`}
  ${company.terms ? html`<h2>Terms</h2><div class="card pre" style="font-size:15px">${company.terms}</div>` : ''}
  ${open ? html`<h2>Approve</h2>
    <div class="form-card">
      ${errorBox(Object.fromEntries(Object.entries(errors).filter(([k]) => k !== 'option')))}
      ${input('signer_name', 'Your full name', values, errors, { autocomplete: 'name', required: true })}
      <label>Signature <span class="muted" style="font-weight:400">(draw with your finger or mouse)</span></label>
      <div class="sigpad"><canvas id="sig" width="600" height="180" aria-label="Signature pad"></canvas>
        <button type="button" class="link" id="sig-clear">Clear</button></div>
      <input type="hidden" name="signature" id="signature">
      ${estimate.deposit_percent && canPayOnline ? input('deposit_email', 'Email for the deposit invoice', { deposit_email: values.deposit_email ?? client.email ?? '' }, errors, { type: 'email', inputmode: 'email' }) : ''}
      <label class="check"><input type="checkbox" name="agree" ${values.agree ? raw('checked') : ''}> <span>I approve this estimate and agree to the terms above.</span></label>
      ${fieldErr(errors, 'agree')}
      <div class="form-actions"><button type="submit" class="block" id="approve" ${preview ? raw('disabled') : ''}>${icon('check')}Approve estimate</button></div>
      ${estimate.deposit_percent && canPayOnline ? html`<div class="hint">Next, you'll be taken to a secure Stripe page to pay the deposit.</div>` : ''}
    </div>` : ''}
  </form>
  ${open ? html`<details class="decline"><summary>Not moving forward?</summary>
    <form method="post" action="${base}/decline" class="form-card" style="margin-top:10px">
      ${textarea('reason', 'Anything we should know? (optional)', {}, {}, { placeholder: 'Timing, budget, went another way…' })}
      <div class="form-actions"><button type="submit" class="secondary" ${preview ? raw('disabled') : ''}>Decline estimate</button></div>
    </form></details>` : ''}
  <div class="actions" style="justify-content:center"><a class="btn ghost" href="${base}/pdf">${icon('download')}Download PDF</a></div>
  <p class="pub-foot">Sent with Keystone</p>
  </div>
  ${open ? html`<script>${raw(SIGNATURE_JS)}</script>` : ''}`, { bare: true, flash, docTitle: `${estimate.project_name} · ${company.name}` });
}
const SIGNATURE_JS = `
(function () {
  var c = document.getElementById('sig'); if (!c) return;
  var ctx = c.getContext('2d'), drawing = false, drawn = false, last = null;
  ctx.lineWidth = 2.6; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#0f172a';
  function pos(e) { var r = c.getBoundingClientRect(); return { x: (e.clientX - r.left) * c.width / r.width, y: (e.clientY - r.top) * c.height / r.height }; }
  c.addEventListener('pointerdown', function (e) { drawing = true; last = pos(e); c.setPointerCapture(e.pointerId); e.preventDefault(); });
  c.addEventListener('pointermove', function (e) {
    if (!drawing) return; var p = pos(e);
    ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke(); last = p; drawn = true; e.preventDefault();
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (t) { c.addEventListener(t, function () { drawing = false; }); });
  document.getElementById('sig-clear').addEventListener('click', function () { ctx.clearRect(0, 0, c.width, c.height); drawn = false; });
  document.getElementById('approve-form').addEventListener('submit', function () {
    document.getElementById('signature').value = drawn ? c.toDataURL('image/png') : '';
  });
  document.querySelectorAll('.opt input[type=radio]').forEach(function (r) {
    r.addEventListener('change', function () {
      document.querySelectorAll('.opt').forEach(function (o) { o.classList.toggle('on', o.contains(r) && r.checked); });
    });
  });
})();`;

// ---------- Jobs ----------
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const LONG_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// Month grid (Sunday first). byDay maps 'YYYY-MM-DD' -> job statuses on that day.
function calendar({ month, day, today, byDay, base = '/jobs' }) {
  const first = month + '-01';
  const [y, m] = month.split('-').map(Number);
  const start = addDays(first, -new Date(first + 'T00:00:00Z').getUTCDay());
  const nextMonth = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  const prevMonth = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
  const cells = [];
  for (let d = start; cells.length < 42; d = addDays(d, 1)) {
    if (cells.length === 35 && d.slice(0, 7) !== month) break; // drop an empty sixth row
    cells.push(d);
  }
  return html`<div class="cal" id="calendar">
    <div class="cal-head">
      <a class="prev" href="${base}?month=${prevMonth}" aria-label="Previous month">${icon('chev', 'sm')}</a>
      <strong>${LONG_MONTHS[m - 1]} ${y}</strong>
      <span class="row" style="gap:6px">${today.slice(0, 7) !== month || day !== today ? html`<a class="today-link" href="${base}">Today</a>` : ''}
        <a href="${base}?month=${nextMonth}" aria-label="Next month">${icon('chev', 'sm')}</a></span>
    </div>
    <div class="cal-grid">
      ${DOW.map((d) => html`<div class="cal-dow">${d.slice(0, 1)}</div>`)}
      ${cells.map((d) => {
        const st = byDay[d] || [];
        const cls = [d.slice(0, 7) !== month ? 'out' : '', d === today ? 'today' : '', d === day ? 'sel' : ''].join(' ');
        return html`<a class="cal-day ${cls}" href="${base}?day=${d}" aria-label="${d}${st.length ? `, ${st.length} job${st.length > 1 ? 's' : ''}` : ''}">
          <span class="n">${Number(d.slice(8))}</span><span class="cal-dots">${st.slice(0, 3).map((x) => html`<i class="${x}"></i>`)}</span></a>`;
      })}
    </div>
  </div>`;
}

// Month / Week switch above the calendar.
const viewSwitch = (base, view, day) => html`<div class="seg view-switch" role="tablist" aria-label="Calendar view">
  <a href="${base}?day=${day}" class="${view === 'week' ? '' : 'on'}" role="tab" aria-selected="${view === 'week' ? 'false' : 'true'}">Month</a>
  <a href="${base}?view=week&day=${day}" class="${view === 'week' ? 'on' : ''}" role="tab" aria-selected="${view === 'week' ? 'true' : 'false'}">Week</a></div>`;

// One week (Sunday first), each day listing what's on it. items(day) returns [{ href, cls, title, sub }].
function weekView({ day, today, base, items }) {
  const start = addDays(day, -new Date(day + 'T00:00:00Z').getUTCDay());
  const end = addDays(start, 6);
  const [sy, sm, sd] = start.split('-').map(Number); const [ey, em, ed] = end.split('-').map(Number);
  const label = `${MONTHS[sm - 1]} ${sd}${sy !== ey ? `, ${sy}` : ''} – ${em !== sm ? `${MONTHS[em - 1]} ` : ''}${ed}, ${ey}`;
  const thisWeek = today >= start && today <= end;
  return html`<div class="cal" id="week">
    <div class="cal-head">
      <a class="prev" href="${base}?view=week&day=${addDays(start, -7)}" aria-label="Previous week">${icon('chev', 'sm')}</a>
      <strong>${label}</strong>
      <span class="row" style="gap:6px">${thisWeek ? '' : html`<a class="today-link" href="${base}?view=week">Today</a>`}
        <a href="${base}?view=week&day=${addDays(start, 7)}" aria-label="Next week">${icon('chev', 'sm')}</a></span>
    </div>
    ${[0, 1, 2, 3, 4, 5, 6].map((i) => {
      const d = addDays(start, i); const list = items(d);
      return html`<div class="wk-day ${d === today ? 'today' : ''}" data-day="${d}">
        <div class="wk-date"><span>${DOW[i]}</span><strong>${Number(d.slice(8))}</strong></div>
        <div class="wk-items">${list.length ? list.map((x) => html`<a class="wk-item ${x.cls}" href="${x.href}">${x.title}<small>${x.sub}</small></a>`)
          : html`<span class="wk-none">—</span>`}</div></div>`;
    })}
  </div>`;
}

function jobsPage({ jobs, status, cal, flash }) {
  const [y, m, d] = cal.day.split('-').map(Number);
  const dayName = DOW[new Date(cal.day + 'T00:00:00Z').getUTCDay()];
  const legend = html`<div class="cal-legend"><span><i style="background:var(--amber)"></i>Not started</span><span><i style="background:var(--blue)"></i>In progress</span>
    <span><i style="background:var(--green)"></i>Completed</span><span><i style="box-shadow:inset 0 0 0 1.6px var(--accent)"></i>Estimate</span></div>`;
  if (cal.view === 'week') {
    const items = (d) => [
      ...cal.weekVisits.filter((e) => e.visit_date === d).map((e) => ({ href: `/estimates/${e.id}`, cls: 'visit',
        title: `${e.visit_time ? `${fmtTime(e.visit_time)} · ` : ''}Estimate: ${e.project_name}`, sub: `${e.client_name}${e.address ? ` · ${e.address}` : ''}` })),
      ...cal.weekJobs.filter((j) => j.start_date <= d && (j.end_date || j.start_date) >= d).map((j) => ({ href: `/jobs/${j.id}`, cls: j.status,
        title: j.project_name, sub: `${j.client_name}${j.address ? ` · ${j.address}` : ''}` })),
    ];
    return layout('Jobs', html`
    ${viewSwitch('/jobs', 'week', cal.day)}
    ${weekView({ day: cal.day, today: cal.today, base: '/jobs', items })}
    ${legend}
    <h2>All jobs</h2>
    ${chips('/jobs', JOB_STATUS, status)}${jobList(jobs, 'No jobs.')}`, { flash });
  }
  return layout('Jobs', html`
  ${viewSwitch('/jobs', 'month', cal.day)}
  ${calendar(cal)}
  ${legend}
  <h2 id="day-jobs">${cal.day === cal.today ? 'Today' : dayName}, ${MONTHS[m - 1]} ${d}${y !== Number(cal.today.slice(0, 4)) ? `, ${y}` : ''}</h2>
  ${cal.dayVisits?.length ? html`<div class="list" id="day-visits">${cal.dayVisits.map((e) => html`<a class="li" href="/estimates/${e.id}">
    <span class="icon-bubble" style="background:var(--accent-soft);color:var(--accent)">${icon('file')}</span>
    <div class="main-t"><div class="t">${e.visit_time ? `${fmtTime(e.visit_time)} · ` : ''}Estimate: ${e.project_name}</div>
      <div class="s">${e.client_name}${e.address ? ` · ${e.address}` : ''}</div></div>${pill(e.status, ESTIMATE_STATUS)}${chev()}</a>`)}</div>` : ''}
  ${cal.dayJobs.length || !cal.dayVisits?.length ? jobList(cal.dayJobs, 'No jobs scheduled this day.') : ''}
  <h2>All jobs</h2>
  ${chips('/jobs', JOB_STATUS, status)}${jobList(jobs, 'No jobs.')}`, { flash });
}

function jobPage({ job, client, expenses, payments, crew = [], members = [], invoices = [], invoicing = {}, photos = [], time = [], forms = {}, emails = [], flash }) {
  const jf = forms.job || { values: { status: job.status, start_date: job.start_date || '', end_date: job.end_date || '', notes: job.notes, address: job.address }, errors: {} };
  const ef = forms.expense || { values: {}, errors: {} };
  const pf = forms.payment || { values: { paid_on: new Intl.DateTimeFormat('en-CA', { timeZone: process.env.APP_TIMEZONE || 'America/Los_Angeles' }).format(new Date()) }, errors: {} };
  const af = forms.assign || { values: {}, errors: {} };
  const vf = forms.invoice || { values: {}, errors: {} };
  const tf = forms.time || { values: { work_date: new Intl.DateTimeFormat('en-CA', { timeZone: process.env.APP_TIMEZONE || 'America/Los_Angeles' }).format(new Date()) }, errors: {} };
  const w2 = members.filter((m) => m.pay_type === 'w2');
  const final = job.status === 'completed';
  return layout(job.project_name, html`
  <p style="margin:0 2px 14px">${pill(job.status, JOB_STATUS)} ${dateRange(job.start_date, job.end_date) ? html`<span class="muted" style="margin-left:6px">${dateRange(job.start_date, job.end_date)}</span>` : ''}</p>
  ${errorBox({ ...jf.errors, ...ef.errors, ...pf.errors, ...af.errors, ...vf.errors, ...tf.errors })}
  <div class="stats" id="job-summary">
    <div class="stat"><div class="k">Contract total</div><div class="v" data-k="contract">${fmt(job.contract_cents)}</div></div>
    <div class="stat"><div class="k">Outstanding</div><div class="v" data-k="balance">${fmt(job.balance_cents)}</div></div>
    <div class="stat"><div class="k">Payments received</div><div class="v" data-k="payments">${fmt(job.payments_cents)}</div></div>
    <div class="stat"><div class="k">Expenses</div><div class="v" data-k="expenses">${fmt(job.expenses_cents)}</div></div>
    <div class="stat"><div class="k">Crew payouts</div><div class="v" data-k="payouts">${fmt(job.payouts_cents)}</div></div>
    <div class="stat ${job.gross_profit_cents >= 0 ? 'good' : 'bad'}"><div class="k">Gross profit ${final ? '(final)' : '(provisional)'}</div>
      <div class="v" data-k="profit">${fmt(job.gross_profit_cents)}</div></div>
  </div>

  <div class="list">
    <a class="li" href="/clients/${client.id}"><span class="icon-bubble">${icon('users')}</span><div class="main-t"><div class="s">Client</div><div class="t">${client.name}</div></div>${chev()}</a>
    ${job.address ? html`<a class="li" href="https://maps.google.com/?q=${encodeURIComponent(job.address)}"><span class="icon-bubble">${icon('pin')}</span><div class="main-t"><div class="s">Job address</div><div class="t">${job.address}</div></div></a>` : ''}
    <a class="li" href="/estimates/${job.estimate_id}"><span class="icon-bubble">${icon('file')}</span><div class="main-t"><div class="s">Original estimate</div><div class="t">View estimate</div></div>${chev()}</a>
  </div>
  <h2 class="row" style="justify-content:space-between">Scope of work <a href="/estimates/${job.estimate_id}/descriptions" id="edit-scope" style="text-transform:none;letter-spacing:0;font-size:14px">Edit</a></h2>
  <div class="card pre">${job.scope || html`<span class="muted">—</span>`}</div>
  <div class="actions"><a class="btn secondary" href="/jobs/${job.id}/work-order" id="work-order">${icon('download')}Work order PDF</a></div>

  <h2>Job details</h2>
  <form method="post" action="/jobs/${job.id}" class="form-card" novalidate>
    <label for="status">Status</label><select id="status" name="status">${options(JOB_STATUS, jf.values.status)}</select>
    ${input('address', 'Job address', jf.values, jf.errors, { autocomplete: 'street-address' })}
    <div class="two">
      <div>${input('start_date', 'Start date', jf.values, jf.errors, { type: 'date' })}</div>
      <div>${input('end_date', 'End date', jf.values, jf.errors, { type: 'date' })}</div>
    </div>
    ${textarea('notes', 'Notes', jf.values, jf.errors, { placeholder: 'Gate codes, materials, reminders…' })}
    <div class="form-actions"><button type="submit">Save job details</button></div>
  </form>

  <h2>Crew & payouts</h2>
  ${crew.length ? html`<div class="list">${crew.map((c) => html`<div class="li">
    <span class="avatar">${initialOf(c)}</span>
    <div class="main-t"><div class="t">${who(c)}</div><div class="s">${c.role === 'removed' ? 'No longer on team' : `${ROLES[c.role]} · ${payLabel(c)}`}${c.pay_type === 'w2' || c.minutes ? ` · ${fmtHours(c.minutes)} worked` : ''}</div></div>
    <div class="r"><span class="amt">${fmt(c.payout_cents + c.labor_cents)}</span><span style="font-size:14px"><a href="/jobs/${job.id}/work-order?user_id=${c.user_id}">Work order</a> · <a href="/jobs/${job.id}/assignments/remove?user_id=${c.user_id}">Remove</a></span></div>
  </div>`)}</div>` : html`<div class="empty">Nobody assigned yet.</div>`}
  ${members.length ? html`<form method="post" action="/jobs/${job.id}/assignments" class="form-card" novalidate>
    <div class="two stack"><div><label for="assign_user">Person</label>
      <select id="assign_user" name="user_id" class="${inv(af.errors, 'user_id')}">
        <option value="">Choose…</option>${members.map((m) => html`<option value="${m.user_id}" ${af.values.user_id === m.user_id ? raw('selected') : ''}>${who(m)} (${m.pay_type === 'w2' ? 'W-2' : 'Sub'})</option>`)}
      </select>${fieldErr(af.errors, 'user_id')}</div>
    <div>${input('payout', 'Fixed payout ($)', af.values, af.errors, { inputmode: 'decimal' })}</div></div>
    <div class="hint">Subcontractors: the fixed amount for this job. W-2 employees: leave blank; they clock in and their hours × hourly rate count automatically. Each person sees only their own pay. Records only; nothing is paid through the app.</div>
    <div class="form-actions"><button type="submit" class="secondary">Assign / update payout</button></div>
  </form>` : ''}

  ${time.length || w2.length ? html`<h2 id="time">Time clock</h2>
  ${time.length ? html`<div class="list" id="time-entries">${time.map((t) => {
    const c = crew.find((x) => x.user_id === t.user_id) || members.find((x) => x.user_id === t.user_id) || {};
    return html`<div class="li">
    <div class="main-t"><div class="t">${who(c) || 'Former teammate'}</div>
      <div class="s">${fmtDate(t.day)} · ${fmtTime(t.start_t)} – ${t.open ? html`<strong style="color:var(--green)">clocked in now</strong>` : fmtTime(t.end_t)} · ${fmtHours(t.minutes)} at ${fmt(t.rate_cents)}/hr</div>
      <div class="row" style="gap:12px;margin-top:6px;font-size:14px">
        ${t.open ? html`<form method="post" action="/time/${t.id}/end"><button type="submit" class="link" style="font-size:14px">Clock out now</button></form>` : ''}
        <form method="post" action="/time/${t.id}/delete" data-confirm="Delete this time entry?"><button type="submit" class="link" style="font-size:14px;color:var(--red)">Delete</button></form></div></div>
    <div class="r"><span class="amt">${t.open ? '—' : fmt(t.cost_cents)}</span></div></div>`;
  })}</div>` : html`<div class="empty">No time recorded yet. W-2 crew assigned to this job clock in from their phone.</div>`}
  ${w2.length ? html`<form method="post" action="/jobs/${job.id}/time" class="form-card" novalidate>
    <h3>Add time by hand</h3>
    <div class="hint">For a missed clock-in. Uses the person's current hourly rate.</div>
    <label for="time_user">Person</label>
    <select id="time_user" name="user_id" class="${inv(tf.errors, 'time_user')}"><option value="">Choose…</option>
      ${w2.map((m) => html`<option value="${m.user_id}" ${tf.values.user_id === m.user_id ? raw('selected') : ''}>${who(m)}${m.hourly_rate_cents != null ? ` (${fmt(m.hourly_rate_cents)}/hr)` : ''}</option>`)}</select>${fieldErr(tf.errors, 'time_user')}
    ${input('work_date', 'Date', tf.values, tf.errors, { type: 'date' })}
    <div class="two"><div>${input('start_time', 'Start', tf.values, tf.errors, { type: 'time' })}</div><div>${input('end_time', 'End', tf.values, tf.errors, { type: 'time' })}</div></div>
    <div class="form-actions"><button type="submit" class="secondary">Add time</button></div>
  </form>` : ''}` : ''}

  <h2 id="photos">Photos</h2>
  ${photoSection(job.id, photos, () => true)}

  <h2>Expenses</h2>
  ${entryList(expenses, 'expenses', (e) => e.description, 'No expenses recorded.')}
  <form method="post" action="/jobs/${job.id}/expenses" class="form-card" novalidate>
    <div class="two stack"><div>${input('description', 'Expense description', ef.values, ef.errors, { required: true })}</div>
    <div>${input('amount', 'Amount ($)', ef.values, ef.errors, { required: true, inputmode: 'decimal' })}</div></div>
    ${receiptField(ef.errors)}
    <div class="form-actions"><button type="submit" class="secondary">Add expense</button></div>
  </form>
  <script>${raw(RECEIPT_JS)}</script>

  <h2>Invoices</h2>
  ${invoiceSection(job, client, invoices, invoicing, vf)}

  <h2>Payments received</h2>
  ${entryList(payments, 'payments', (p) => html`${p.invoice_number ? `Paid online · ${p.invoice_number}` : 'Payment'} · ${fmtDate(p.paid_on)}`, 'No payments recorded.')}
  <form method="post" action="/jobs/${job.id}/payments" class="form-card" novalidate>
    <div class="two stack"><div>${input('payment_amount', 'Amount ($)', pf.values, pf.errors, { required: true, inputmode: 'decimal' })}</div>
    <div>${input('paid_on', 'Date received', pf.values, pf.errors, { type: 'date', required: true })}</div></div>
    <div class="hint">For cash, checks and other payments received outside the app. Invoices paid online are recorded automatically.</div>
    <div class="form-actions"><button type="submit" class="secondary">Record payment</button></div>
  </form>
  ${emailHistory(emails)}`, { flash, back: { href: '/jobs', label: 'Jobs' } });
}

// Job photos: a grid of thumbnails (tap to open full size) plus an "Add photos" button.
function photoSection(jobId, photos, canDelete) {
  return html`${photos.length ? html`<div class="photos" id="photo-grid">${photos.map((p) => html`<div class="photo">
    <a href="/photos/${p.id}" target="_blank" rel="noopener"><img src="/photos/${p.id}" alt="Job photo from ${fmtDate(p.created_at.slice(0, 10))}" loading="lazy"></a>
    ${canDelete(p) ? html`<form method="post" action="/photos/${p.id}/delete" data-confirm="Delete this photo?"><button type="submit" class="photo-del" aria-label="Delete photo">×</button></form>` : ''}
  </div>`)}</div>` : html`<div class="empty">No photos yet.</div>`}
  <label class="btn secondary block photo-add" style="margin-top:10px">${icon('camera')}<span>Add photos</span>
    <input type="file" accept="image/*" multiple hidden data-photo-upload="/jobs/${jobId}/photos"></label>
  <script>${raw(PHOTO_JS)}</script>`;
}
// Shrinks each chosen photo to JPEG (1600px on the long side) and uploads them one by one, then reloads.
const PHOTO_JS = `
(function () {
  document.querySelectorAll('[data-photo-upload]').forEach(function (inp) {
    if (inp.dataset.ready) return; inp.dataset.ready = '1';
    var label = inp.closest('label').querySelector('span');
    function shrink(f) {
      return new Promise(function (resolve, reject) {
        var img = new Image();
        img.onload = function () {
          var scale = Math.min(1, 1600 / Math.max(img.width, img.height));
          var c = document.createElement('canvas'); c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
          var ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(img, 0, 0, c.width, c.height);
          URL.revokeObjectURL(img.src); resolve(c.toDataURL('image/jpeg', 0.82));
        };
        img.onerror = function () { reject(new Error('read')); };
        img.src = URL.createObjectURL(f);
      });
    }
    inp.addEventListener('change', async function () {
      var files = Array.prototype.slice.call(inp.files); if (!files.length) return;
      var failed = 0;
      for (var i = 0; i < files.length; i++) {
        label.textContent = 'Uploading ' + (i + 1) + ' of ' + files.length + '…';
        try {
          var data = await shrink(files[i]);
          var r = await fetch(inp.dataset.photoUpload, { method: 'POST', body: new URLSearchParams({ photo_data: data }) });
          if (!r.ok) failed++;
        } catch (e) { failed++; }
      }
      if (failed) alert(failed + ' photo' + (failed > 1 ? 's' : '') + " couldn't be added. Use JPG or PNG photos.");
      location.hash = 'photos'; location.reload();
    });
  });
})();`;

const INVOICE_STATUS = { open: 'Sent', paid: 'Paid', void: 'Voided', uncollectible: 'Uncollectible' };
const INVOICE_PILL = { open: 'sent', paid: 'completed', void: 'declined', uncollectible: 'declined' };
function invoiceSection(job, client, invoices, invoicing, vf) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: process.env.APP_TIMEZONE || 'America/Los_Angeles' }).format(new Date());
  const list = invoices.length ? html`<div class="list" id="invoices">${invoices.map((i) => {
    const overdue = i.status === 'open' && i.due_date && i.due_date < today;
    return html`<div class="li">
    <div class="main-t"><div class="t">${i.number || 'Invoice'} · ${i.description}</div>
      <div class="s">${i.status === 'paid' ? html`Paid ${fmtDate(String(i.paid_at).slice(0, 10))}` : html`To ${i.sent_to}${i.due_date ? html` · due ${fmtDate(i.due_date)}` : ''}`}</div>
      <div class="row" style="gap:12px;margin-top:6px;font-size:14px">
        ${i.hosted_url ? html`<a href="${i.hosted_url}" target="_blank" rel="noopener">View</a>` : ''}
        ${i.status === 'open' && invoicing.enabled ? html`
          <form method="post" action="/invoices/${i.id}/resend"><button type="submit" class="link" style="font-size:14px">Resend</button></form>
          <form method="post" action="/invoices/${i.id}/void" data-confirm="Void this invoice? The client's pay link will stop working."><button type="submit" class="link" style="font-size:14px;color:var(--red)">Void</button></form>` : ''}
      </div></div>
    <div class="r"><span class="amt">${fmt(i.amount_cents)}</span><span class="pill ${overdue ? 'declined' : INVOICE_PILL[i.status]}">${overdue ? 'Overdue' : INVOICE_STATUS[i.status]}</span></div>
  </div>`;
  })}</div>` : '';
  if (!invoicing.enabled) {
    return html`${list}<div class="empty" style="text-align:left">Online invoicing isn't set up yet. <a href="/settings#online-payments">Connect Stripe</a> in Company profile to email clients an invoice they can pay online; payments are then recorded here automatically.</div>`;
  }
  if (job.balance_cents <= 0) return html`${list}${invoices.length ? '' : html`<div class="empty">Nothing is owed on this job.</div>`}`;
  const unbilled = Math.max(0, job.balance_cents - invoices.filter((i) => i.status === 'open').reduce((t, i) => t + i.amount_cents, 0));
  const values = { invoice_amount: plainCents(unbilled || job.balance_cents), invoice_email: client.email, days: '14', invoice_desc: job.project_name, key: invoicing.key, ...vf.values };
  return html`${list}
  <form method="post" action="/jobs/${job.id}/invoices" class="form-card" id="invoice-form" novalidate
    data-confirm="Email this invoice to the client now?">
    <h3>Send an invoice</h3>
    <div class="hint">Stripe emails the client a secure link to pay by card or bank transfer. When they pay, it's recorded under Payments received.${invoicing.testMode ? ' Test mode: no real money moves and Stripe does not email clients.' : ''}</div>
    <input type="hidden" name="key" value="${values.key}">
    ${progressBar(job, invoices)}
    <label>Progress invoice</label>
    <div class="chips progress-presets" id="progress-presets">${[10, 25, 33, 50].map((pct) => {
      const cents = Math.min(job.balance_cents, Math.round(job.contract_cents * pct / 100));
      return html`<button type="button" class="chip" data-amount="${plainCents(cents)}" data-desc="${job.project_name}: progress payment (${pct}% of ${fmt(job.contract_cents)})">${pct}%</button>`;
    })}<button type="button" class="chip" data-amount="${plainCents(job.balance_cents)}" data-desc="${job.project_name}: final payment">Remaining</button></div>
    <div class="two stack"><div>${input('invoice_amount', 'Amount ($)', values, vf.errors, { required: true, inputmode: 'decimal', hint: `Outstanding: ${fmt(job.balance_cents)}` })}</div>
    <div><label for="days">Payment due</label><select id="days" name="days">${options({ 0: 'On receipt', 7: 'In 7 days', 14: 'In 14 days', 30: 'In 30 days' }, String(values.days))}</select></div></div>
    ${input('invoice_email', 'Send to', values, vf.errors, { type: 'email', required: true, inputmode: 'email' })}
    ${input('invoice_desc', 'Description on the invoice', values, vf.errors)}
    <div class="form-actions"><button type="submit">Send invoice</button></div>
  </form>
  <script>${raw(`document.querySelectorAll('#progress-presets .chip').forEach(function (b) { b.addEventListener('click', function () {
    document.getElementById('invoice_amount').value = b.dataset.amount; document.getElementById('invoice_desc').value = b.dataset.desc;
    document.querySelectorAll('#progress-presets .chip').forEach(function (x) { x.classList.toggle('on', x === b); }); }); });`)}</script>`;
}
// How much of the contract has been paid, and how much more is on open invoices.
function progressBar(job, invoices) {
  const sent = invoices.filter((i) => i.status === 'open').reduce((t, i) => t + i.amount_cents, 0);
  const pct = (c) => (job.contract_cents ? Math.min(100, (c / job.contract_cents) * 100) : 0);
  return html`<div class="billed" id="billed-progress">
    <div class="billed-bar"><span class="paid" style="width:${pct(job.payments_cents).toFixed(1)}%"></span><span class="sent" style="width:${Math.min(pct(sent), 100 - pct(job.payments_cents)).toFixed(1)}%"></span></div>
    <div class="billed-k"><span><i class="paid"></i>Paid ${fmt(job.payments_cents)}</span><span><i class="sent"></i>Invoiced, not paid ${fmt(sent)}</span><span>Contract ${fmt(job.contract_cents)}</span></div>
  </div>`;
}
const plainCents = (c) => `${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`;

const receiptField = (errors, current) => html`<label for="receipt-file">Receipt</label>
  <div class="row receipt-pick" style="align-items:center;gap:10px">
    <label class="btn sm secondary" for="receipt-file" style="margin:0;color:var(--accent)">${icon('camera')}${current ? 'Replace' : 'Add photo or PDF'}</label>
    <span class="muted receipt-name" style="font-size:13px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${current || ''}</span>
  </div>
  <input type="file" id="receipt-file" accept="image/*,application/pdf" style="display:none">
  <input type="hidden" name="receipt_data" id="receipt_data" value=""><input type="hidden" name="receipt_name" id="receipt_name" value="">
  ${fieldErr(errors, 'receipt')}`;

// Photos are shrunk in the browser (longest side 1600px, JPEG) before sending; PDFs go as they are, up to 5 MB.
const RECEIPT_JS = `
(function () {
  var file = document.getElementById('receipt-file'); if (!file) return;
  var form = file.form || file.closest('form');
  function done(data, name) {
    document.getElementById('receipt_data').value = data; document.getElementById('receipt_name').value = name;
    document.querySelector('.receipt-name').textContent = name;
  }
  file.addEventListener('change', function () {
    var f = file.files[0]; if (!f) return;
    if (f.type === 'application/pdf') {
      if (f.size > 5 * 1024 * 1024) { alert('That PDF is over 5 MB. Try a smaller file or a photo.'); file.value = ''; return; }
      var rd = new FileReader(); rd.onload = function () { done(rd.result, f.name); }; rd.readAsDataURL(f); return;
    }
    var img = new Image();
    img.onload = function () {
      var scale = Math.min(1, 1600 / Math.max(img.width, img.height));
      var c = document.createElement('canvas');
      c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      var ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(img, 0, 0, c.width, c.height);
      done(c.toDataURL('image/jpeg', 0.82), (f.name || 'receipt').replace(/\\.[^.]+$/, '') + '.jpg');
      URL.revokeObjectURL(img.src);
    };
    img.onerror = function () { alert('That file could not be read. Use a photo (JPG or PNG) or a PDF.'); file.value = ''; };
    img.src = URL.createObjectURL(f);
  });
})();`;

function entryList(rows, kind, title, empty) {
  if (!rows.length) return html`<div class="empty">${empty}</div>`;
  return html`<div class="list">${rows.map((r) => html`<div class="li">
    <div class="main-t"><div class="t">${title(r)}</div>
      <div class="s">${r.has_receipt ? html`<a href="/expenses/${r.id}/receipt" target="_blank" rel="noopener" class="receipt-link">${icon('file', 'sm')}Receipt</a> · ` : ''}<a href="/${kind}/${r.id}/edit">Edit</a> · <a href="/${kind}/${r.id}/delete">Delete</a></div></div>
    <div class="r"><span class="amt">${fmt(r.amount_cents)}</span></div>
  </div>`)}</div>`;
}

function entryFormPage({ kind, entry, job, values, errors = {} }) {
  const isExpense = kind === 'expenses';
  return layout(isExpense ? 'Edit expense' : 'Edit payment', html`
  ${errorBox(errors)}
  <form method="post" action="/${kind}/${entry.id}" novalidate>
    <div class="form-card">
      ${isExpense ? input('description', 'Description', values, errors, { required: true }) : ''}
      ${input('amount', 'Amount ($)', values, errors, { required: true, inputmode: 'decimal' })}
      ${isExpense ? '' : input('paid_on', 'Date received', values, errors, { type: 'date', required: true })}
      ${isExpense ? html`${receiptField(errors, entry.has_receipt ? 'Receipt attached' : '')}
        ${entry.has_receipt ? html`<div class="row" style="gap:14px;margin-top:8px"><a href="/expenses/${entry.id}/receipt" target="_blank" rel="noopener">View receipt</a>
          <label style="margin:0;display:flex;gap:6px;align-items:center;font-weight:500"><input type="checkbox" name="remove_receipt" value="1" style="width:18px;min-height:0;height:18px">Remove receipt</label></div>` : ''}` : ''}
    </div>
    <div class="form-actions"><a class="btn secondary" href="/jobs/${job.id}">Cancel</a><button type="submit">Save</button></div>
  </form>${isExpense ? html`<script>${raw(RECEIPT_JS)}</script>` : ''}`, { back: { href: `/jobs/${job.id}`, label: job.project_name }, sub: html`For ${job.project_name}` });
}

function confirmPage({ title, message, action, cancelHref, button = 'Yes, delete it' }) {
  return layout(title, html`
  <div class="card"><p style="margin:0">${message}</p></div>
  <form method="post" action="${action}" class="form-actions">
    <a class="btn secondary" href="${cancelHref}">Cancel</a>
    <button type="submit" class="danger solid">${button}</button>
  </form>`, { back: { href: cancelHref, label: 'Back' } });
}

function confirmDeletePage({ kind, entry, job }) {
  const what = kind === 'expenses'
    ? html`the expense <strong>${entry.description}</strong> (${fmt(entry.amount_cents)})`
    : html`the payment of <strong>${fmt(entry.amount_cents)}</strong> received ${fmtDate(entry.paid_on)}`;
  return confirmPage({ title: 'Delete this entry?', action: `/${kind}/${entry.id}/delete`, cancelHref: `/jobs/${job.id}`,
    message: html`You are about to permanently delete ${what} from ${job.project_name}.` });
}

function messagePage(title, message) {
  return layout(title, html`<div class="card"><p style="margin:0">${message}</p></div>
    <a class="btn secondary block" href="/">Back to home</a>`);
}

module.exports = {
  ESTIMATE_STATUS, JOB_STATUS, nav, publicEstimatePage, schedulePage, scheduleJobPage, crewHomePage, crewJobsPage, confirmPage, loginPage, signupPage, welcomePage,
  legalPage, accountPage, descriptionsPage, billingPage, teamPage, memberPage, settingsPage, homePage, clientsPage, clientFormPage, clientPage, estimatesPage, estimateFormPage, estimatePage,
  jobsPage, jobPage, entryFormPage, confirmDeletePage, messagePage, landingPage, forgotPage, resetPage, deleteAccountPage, deleteCompanyPage, importPage,
};
