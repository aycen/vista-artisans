'use strict';
const { html, raw } = require('./html');
const { fmt, fmtQty } = require('./money');

const ESTIMATE_STATUS = { draft: 'Draft', sent: 'Sent', approved: 'Approved', declined: 'Declined' };
const JOB_STATUS = { not_started: 'Not started', in_progress: 'In progress', completed: 'Completed' };
const ROLES = { admin: 'Admin', worker: 'Worker' };
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
@media (prefers-color-scheme:dark){:root{
  --bg:#0b0d14;--surface:#151823;--surface-2:#1b1f2c;--text:#eef1f7;--text-2:#a5adbf;--text-3:#6b7389;
  --line:#262b3a;--accent:#818cf8;--accent-2:#6366f1;--accent-soft:#232647;--on-accent:#0b0d14;
  --green:#34d399;--green-soft:#0f2a22;--amber:#fbbf24;--amber-soft:#2d2412;--red:#f87171;--red-soft:#321617;
  --blue:#60a5fa;--blue-soft:#14223a;--gray-soft:#20253a;--shadow:0 1px 2px rgba(0,0,0,.3);color-scheme:dark;
}}
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

/* Surfaces */
.card{background:var(--surface);border-radius:var(--radius);box-shadow:var(--shadow);padding:18px;margin-bottom:14px}
.card.flush{padding:0;overflow:hidden}
.hero{border-radius:22px;padding:20px;color:#fff;margin:6px 0 14px;background:linear-gradient(135deg,#4338ca 0%,#6d28d9 55%,#be185d 120%);box-shadow:0 12px 30px rgba(79,70,229,.28)}
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
.two{display:grid;grid-template-columns:1fr 1fr;gap:0 12px}
.two>div{min-width:0}
input[type=date]{min-width:0;-webkit-appearance:none;appearance:none;display:block}
@media (max-width:520px){.two.stack{grid-template-columns:1fr}}
.form-actions{display:flex;gap:10px;margin:18px 0}
.form-actions>*{flex:1}
.search{position:relative;margin:4px 0 14px}
.search .svg{position:absolute;left:14px;top:50%;transform:translateY(-50%);color:var(--text-3)}
.search input{padding-left:44px;background:var(--surface);border-color:transparent;box-shadow:var(--shadow)}

/* Line items */
.item{background:var(--surface-2);border-radius:14px;padding:12px;margin-top:10px}
.item .grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px}
.item input{background:var(--surface)}
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
.cal-dots i.in_progress{background:var(--blue)} .cal-dots i.completed{background:var(--green)}
@media (hover:hover){a.cal-day:hover{background:var(--surface-2)}}
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
.seg{display:flex;background:var(--surface-2);border-radius:12px;padding:4px;margin:6px 0 14px;max-width:340px}
.seg a{flex:1;text-align:center;padding:9px 10px;border-radius:9px;color:var(--text-2);font-weight:600;text-decoration:none;font-size:15px}
.seg a.on{background:var(--surface);color:var(--text);box-shadow:var(--shadow)}
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
const pill = (status, labels) => html`<span class="pill ${status}">${labels[status] || status}</span>`;

// ---------- Layout ----------
// The server fills <!--NAV--> (sidebar + tab bar) and <!--AVATAR--> for the signed-in user.
function layout(title, body, { flash, back, sub, fab, bare = false, pageTitle, docTitle } = {}) {
  return html`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#f3f4f8" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0b0d14" media="(prefers-color-scheme: dark)">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default"><meta name="apple-mobile-web-app-title" content="Vista">
<link rel="manifest" href="/static/manifest.webmanifest"><link rel="icon" href="/static/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/static/apple-touch-icon.png">
<title>${docTitle || `${title} · Vista Artisans`}</title><style>${raw(CSS)}</style></head>
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
const WORKER_TABS = [['/', 'Schedule', 'calendar'], ['/account', 'Account', 'account']];
const activeTab = (path, href) => (href === '/' ? path === '/' || path.startsWith('/schedule') : path.startsWith(href));

function nav({ user, org, path = '/' }) {
  const tabs = !org ? [['/account', 'Account', 'account']] : org.role === 'admin' ? ADMIN_TABS : WORKER_TABS;
  const initial = initialOf(user);
  return {
    nav: html`<nav class="sidebar" aria-label="Main">
      <a class="brand" href="/"><span class="mark">VA</span>${org ? org.name : 'Vista Artisans'}</a>
      ${tabs.map(([href, label, ic]) => html`<a class="nav ${activeTab(path, href) ? 'on' : ''}" href="${href}">${icon(ic)}${label}</a>`)}
      <span class="grow"></span>
      ${org && org.role === 'admin' ? html`<a class="nav ${path.startsWith('/account') ? 'on' : ''}" href="/account">${icon('account')}Account</a>` : ''}
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

// ---------- Auth & onboarding ----------
function authPage(title, sub, body) {
  return layout(title, html`<div class="auth">
    <div class="mark lg">VA</div>
    <h1>${title}</h1><p class="sub">${sub}</p>
    ${body}
  </div>`, { bare: true });
}

function loginPage({ error, notice, email = '' } = {}) {
  return authPage('Welcome back', 'Log in to Vista Artisans', html`
    ${error ? html`<div class="errors" role="alert">${error}</div>` : ''}
    ${notice ? html`<div class="notice">${notice}</div>` : ''}
    <form method="post" action="/login" class="form-card">
      <label for="email">Email</label>
      <input id="email" name="email" type="email" autocomplete="email" inputmode="email" value="${email}" required autofocus>
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required>
      <div class="form-actions"><button type="submit">Log in</button></div>
    </form>
    <p class="alt">New here? <a href="/signup">Create an account</a></p>`);
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
      ${input('address', 'Address', values, errors, { autocomplete: 'street-address' })}
      <div class="hint">Shown to your company's admins. You can change these later in Account.</div>
      <div class="form-actions"><button type="submit">Create account</button></div>
    </form>
    <p class="alt">Already have an account? <a href="/login">Log in</a></p>`);
}

function welcomePage({ errors = {}, values = {}, hasOrgs }) {
  return layout(hasOrgs ? 'Join or create' : 'Get started', html`
  ${errorBox(errors)}
  <form method="post" action="/org/join" class="form-card" novalidate>
    <h3>Join your company</h3>
    <div class="hint">Ask your admin for the company's join code. You'll join as a worker; your admin can change that.</div>
    ${input('code', 'Join code', values, errors, { placeholder: 'ABCD-2345', autocomplete: 'off' })}
    <div class="form-actions"><button type="submit">Join company</button></div>
  </form>
  <form method="post" action="/org/new" class="form-card" novalidate>
    <h3>Start a new company</h3>
    <div class="hint">For owners setting up Vista for the first time. You'll be its admin.</div>
    ${input('name', 'Company name', values, errors)}
    <div class="form-actions"><button type="submit" class="secondary">Create company</button></div>
  </form>`, { sub: hasOrgs ? null : 'One last step before you start.', back: hasOrgs ? { href: '/account', label: 'Account' } : null });
}

function accountPage({ user, org, orgs, plan, values = {}, errors = {}, flash }) {
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
    ${input('address', 'Address', values, errors, { autocomplete: 'street-address' })}
    <div class="form-actions"><button type="submit" class="secondary">Save details</button></div>
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
    <a class="li" href="/billing"><span class="icon-bubble">${icon('card')}</span>
    <div class="main-t"><div class="t">Plan & billing</div><div class="s">${PLAN_NAMES[plan] || 'Free'} plan</div></div>${chev()}</a></div>` : ''}
  <div class="actions">
    <a class="btn secondary" href="/welcome">${icon('key')}Join or create a company</a>
  </div>
  <form method="post" action="/logout"><button type="submit" class="danger block">${icon('logout')}Log out</button></form>`, { flash });
}

// ---------- Company profile ----------
function settingsPage({ org, values, hasLogo, errors = {}, flash, payments = null, emailValues = null, emailErrors = {}, emailEnabled = false }) {
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
      <div class="two stack"><div>${input('website', 'Website', values, errors, { placeholder: 'vistaartisans.com' })}</div>
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
  ${emailValues ? emailSettings(emailValues, emailErrors, emailEnabled) : ''}
  <script>${raw(LOGO_JS)}</script>`, { flash, back: { href: '/account', label: 'Account' } });
}

function emailSettings(ev, errors, enabled) {
  const toggle = (name, label, hint) => html`<label class="check"><input type="checkbox" name="${name}" ${ev[name] ? raw('checked') : ''}>
    <span>${label}<div class="hint" style="font-weight:400;margin:2px 0 0">${hint}</div></span></label>`;
  return html`<h2 id="emails">Automatic emails & approvals</h2>
  ${errorBox(errors)}
  <form method="post" action="/settings/emails" class="form-card" novalidate id="email-settings">
    ${enabled ? '' : html`<div class="notice">Emailing isn't switched on for this app yet, so nothing will be sent. You can still set these up now.</div>`}
    <div class="hint" style="margin:0 0 8px">Emails come from your company name, and replies go to your business email above.</div>
    <label for="estimate_followup_days">Follow up on estimates that haven't been approved</label>
    <select id="estimate_followup_days" name="estimate_followup_days">${[['0', 'Off'], ['2', 'After 2 days, then 4'], ['3', 'After 3 days, then 6'], ['5', 'After 5 days, then 10'], ['7', 'After 7 days, then 14']]
      .map(([k, l]) => html`<option value="${k}" ${String(ev.estimate_followup_days) === k ? raw('selected') : ''}>${l}</option>`)}</select>
    ${toggle('appointment_reminders', 'Appointment reminders', 'The day before a job starts, remind the client by email.')}
    ${toggle('review_requests', 'Ask for a review', 'An hour after you mark a job completed, ask the client for a review.')}
    ${input('review_url', 'Review link', ev, errors, { placeholder: 'https://g.page/r/…', hint: 'Your Google (or Yelp, Facebook…) review page.' })}
    ${input('default_deposit_percent', 'Default deposit for new estimates (%)', ev, errors, { inputmode: 'numeric', hint: 'Clients pay it online when they approve, if Stripe is connected. 0 for none.' })}
    <div class="form-actions"><button type="submit" class="secondary">Save email settings</button></div>
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
const PLAN_LIMITS = { free: { people: 1 }, team: { admins: 3, workers: 10 }, unlimited: {} };
const PRICES = { team: { month: 4900, year: 49900 }, unlimited: { month: 9900, year: 100900 } };
const dollars = (c) => `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;

function seatsLeft(plan, members) {
  const admins = members.filter((m) => m.role === 'admin').length;
  const workers = members.length - admins;
  if (plan === 'unlimited') return `${members.length} ${members.length === 1 ? 'person' : 'people'} · no limits`;
  if (plan === 'team') return `${admins} of 3 admins · ${workers} of 10 workers`;
  return members.length > 1 ? `${members.length} people · upgrade to add more` : 'Just you · upgrade to add your crew';
}

function billingPage({ org, sub, plan, counts, enabled, testMode, interval = 'month', error, flash }) {
  const paid = ['active', 'trialing', 'past_due'].includes(sub.status) && sub.plan !== 'free';
  const discount = interval === 'month' && !sub.first_month_discount_used;
  const usage = plan === 'team' ? `${counts.admins} of 3 admins · ${counts.workers} of 10 workers`
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
    ${card('team', 'Team', 'For a small crew.', ['Up to 3 admins', 'Up to 10 workers', 'Everything in Free'])}
    ${card('unlimited', 'Unlimited', 'For growing companies.', ['Unlimited admins', 'Unlimited workers', 'Everything in Team'])}
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
    <div class="hint">Share this with your crew. After creating an account, they enter it to join ${org.name} as workers.</div>
  </div>` : ''}
  <h2>People</h2>
  <div class="list">${members.map((m) => html`<a class="li" href="/team/${m.user_id}">
    <span class="avatar">${initialOf(m)}</span>
    <div class="main-t"><div class="t">${who(m)}${m.user_id === me ? html` <span class="muted">(you)</span>` : ''}</div>
      <div class="s">${ROLES[m.role]} · ${m.job_count} job${m.job_count === 1 ? '' : 's'}${m.full_name ? ` · ${m.email}` : ''}</div></div>
    <div class="r"><span class="amt">${fmt(m.earned_cents)}</span><span class="muted" style="font-size:12px">paid on completed jobs</span></div>${chev()}
  </a>`)}</div>
  <p class="hint"><strong>Admins</strong> see and manage everything, including money and the team.
    <strong>Workers</strong> see only open jobs assigned to them: dates, address, scope of work and their own pay.</p>
  ${admin ? html`<form method="post" action="/team/add" class="form-card" novalidate>
    <h3>Add by email</h3>
    <div class="hint">For someone who already has an account.</div>
    ${input('email', 'Email', values, errors, { type: 'email', required: true, inputmode: 'email' })}
    <label for="new-role">Role</label>${roleSelect('role', values.role || 'worker', 'new-role')}
    <div class="form-actions"><button type="submit">Add to ${org.name}</button></div>
  </form>` : ''}`, { flash });
}

function memberPage({ org, member, me, jobs, totals, errors = {}, flash }) {
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
    ${member.address ? html`<a class="li" href="https://maps.google.com/?q=${encodeURIComponent(member.address)}"><span class="icon-bubble">${icon('pin')}</span><div class="main-t"><div class="s">Address</div><div class="t">${member.address}</div></div></a>` : ''}
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

// ---------- Worker schedule ----------
function schedulePage({ jobs, flash }) {
  return layout('Schedule', jobs.length ? html`<div class="list">${jobs.map((j) => html`
    <a class="li" href="/schedule/${j.job_id}">
      <span class="icon-bubble">${icon('calendar')}</span>
      <div class="main-t"><div class="t">${j.project_name}</div>
        <div class="s">${dateRange(j.start_date, j.end_date) || 'Not scheduled yet'} · ${j.address || j.client_name}</div></div>
      <div class="r">${j.my_payout_cents == null ? '' : html`<span class="amt">${fmt(j.my_payout_cents)}</span>`}${pill(j.status, JOB_STATUS)}</div>
      ${chev()}
    </a>`)}</div>`
    : html`<div class="empty">No open jobs assigned to you.</div>`, { flash, sub: 'Your upcoming and active jobs' });
}

function scheduleJobPage({ job }) {
  return layout(job.project_name, html`
  <p style="margin:0 2px 14px">${pill(job.status, JOB_STATUS)}</p>
  ${job.my_payout_cents == null ? '' : html`<div class="hero"><div class="k">Your pay for this job</div>
    <div class="v" data-k="my-pay">${fmt(job.my_payout_cents)}</div></div>`}
  <div class="list">
    <div class="kv"><span class="k">Dates</span><span class="v">${dateRange(job.start_date, job.end_date) || 'Not scheduled yet'}</span></div>
    <div class="kv"><span class="k">Client</span><span class="v">${job.client_name}</span></div>
    <div class="kv"><span class="k">Address</span><span class="v">${job.address ? html`<a href="https://maps.google.com/?q=${encodeURIComponent(job.address)}">${job.address}</a>` : '—'}</span></div>
  </div>
  <h2>Scope of work</h2><div class="card pre">${job.scope || '—'}</div>
  ${job.notes ? html`<h2>Notes</h2><div class="card pre">${job.notes}</div>` : ''}`,
  { back: { href: '/', label: 'Schedule' } });
}

// ---------- Home ----------
// Revenue growth: this month so far vs the same days of last month.
function growthBadge(m) {
  if (!m.prevCents) {
    return html`<span class="delta" id="revenue-growth">${m.revenueCents ? 'No payments by this point last month' : 'No payments yet'}</span>`;
  }
  const pct = ((m.revenueCents - m.prevCents) / m.prevCents) * 100;
  const shown = `${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(Math.abs(pct) < 10 ? 1 : 0)}%`;
  return html`<span class="delta" id="revenue-growth">${pct >= 0 ? '▲' : '▼'} ${shown} vs ${m.prevLabel}</span>`;
}

function homePage({ openEstimates, activeJobs, outstandingCents, month, flash }) {
  const profitClass = month.profitCents > 0 ? 'good' : month.profitCents < 0 ? 'bad' : '';
  return layout('Home', html`
  <div class="hero">
    <div class="k">Revenue · ${month.label}</div>
    <div class="v" id="month-revenue">${fmt(month.revenueCents)}</div>
    <div class="s">Payments received this month</div>
    ${growthBadge(month)}
  </div>
  <div class="stats four">
    <div class="stat wide-sm ${profitClass}"><div class="k">Gross profit · ${month.label}</div><div class="v" id="month-profit">${fmt(month.profitCents)}</div>
      <div class="s">${month.completedJobs ? `From ${month.completedJobs} job${month.completedJobs > 1 ? 's' : ''} completed this month` : 'No jobs completed this month yet'}</div></div>
    <div class="stat wide-sm"><div class="k">Outstanding</div><div class="v" id="total-outstanding">${fmt(outstandingCents)}</div><div class="s">Owed across all jobs</div></div>
    <div class="stat"><div class="k">Active jobs</div><div class="v">${activeJobs.length}</div></div>
    <div class="stat"><div class="k">Open estimates</div><div class="v">${openEstimates.length}</div></div>
  </div>
  <div class="actions">
    <a class="btn secondary" href="/clients/new">${icon('plus')}New Client</a>
    <a class="btn" href="/estimates/new">${icon('plus')}New Estimate</a>
  </div>
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
function clientsPage({ clients, q }) {
  return layout('Clients', html`
  <form method="get" action="/clients" class="search" role="search">
    ${icon('search')}<input name="q" type="search" value="${q}" placeholder="Search by name" aria-label="Search by name">
  </form>
  ${clients.length ? html`<div class="list">${clients.map((c) => html`<a class="li" href="/clients/${c.id}">
    <span class="avatar">${c.name[0].toUpperCase()}</span>
    <div class="main-t"><div class="t">${c.name}</div><div class="s">${c.address || c.phone || c.email || ' '}</div></div>${chev()}
  </a>`)}</div>` : html`<div class="empty">${q ? 'No clients match that name.' : 'No clients yet.'}</div>`}`,
  { fab: { href: '/clients/new', label: 'New Client' } });
}

function clientFields(values, errors, prefix = '') {
  const v = {}; const er = {};
  for (const k of ['name', 'phone', 'email', 'address']) { v[prefix + k] = values[prefix + k]; er[prefix + k] = errors[prefix + k]; }
  return html`
    ${input(prefix + 'name', 'Name', v, er, { required: true, autocomplete: 'off' })}
    <div class="two stack"><div>${input(prefix + 'phone', 'Phone', v, er, { type: 'tel', inputmode: 'tel' })}</div>
    <div>${input(prefix + 'email', 'Email', v, er, { type: 'email', inputmode: 'email' })}</div></div>
    ${input(prefix + 'address', 'Property address', v, er)}`;
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
  return layout(client.name, html`
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
  const all = [...items, ...Array.from({ length: items.length ? 1 : 2 }, () => ({ desc: '', qty: '', price: '', option: '' }))];
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
      ${input('project_name', 'Project name', values, errors, { required: true })}
      ${textarea('scope', 'Scope of work', values, errors, { placeholder: 'What the job includes…' })}
      <label for="status">Status</label>
      <select id="status" name="status">${options(ESTIMATE_STATUS, values.status)}</select>
    </div>
    <h2>Line items</h2>
    ${errors.items ? html`<div class="field-error" style="margin:0 4px 8px">${errors.items}</div>` : ''}
    ${errors.options ? html`<div class="field-error" style="margin:0 4px 8px">${errors.options}</div>` : ''}
    <p class="hint" style="margin:0 4px 8px">Want to offer choices? Put an option name like <strong>Good</strong>, <strong>Better</strong> or <strong>Best</strong> on lines;
      the client picks one when approving. Lines with no option are included in every choice.</p>
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
  <template id="item-template">${itemRow({ desc: '', qty: '', price: '', option: '' })}</template>
  <script>${raw(ESTIMATE_JS)}</script>`, { back: { href: cancel, label: estimate ? estimate.project_name : 'Estimates' } });
}

function itemRow(it, err) {
  return html`<div class="item">
    <input name="item_desc" value="${it.desc}" aria-label="Description" placeholder="Description" class="${err ? 'invalid' : ''}">
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
  return html`<h2>Emails</h2><div class="list" id="email-history">${emails.map((m) => html`<div class="li">
    <span class="icon-bubble">${icon('mail')}</span>
    <div class="main-t"><div class="t">${EMAIL_KINDS[m.kind] || m.kind}</div><div class="s">${m.to_email} · ${fmtWhen(m.created_at)}</div></div>
    ${m.status === 'failed' ? html`<span class="pill declined" title="${m.error}">Failed</span>` : html`<span class="pill completed">Sent</span>`}</div>`)}</div>`;
}

// Line items grouped by option (shared lines first). Used on the company's page and the client's page.
function itemGroups(items) {
  const shared = items.filter((i) => !i.option_name);
  const names = [...new Set(items.filter((i) => i.option_name).map((i) => i.option_name))];
  return { shared, groups: names.map((name) => ({ name, items: items.filter((i) => i.option_name === name) })) };
}
const itemRows = (list) => list.map((i) => html`<tr><td>${i.description}<div class="muted" style="font-size:13px">${fmtQty(i.qty_hundredths)} × ${fmt(i.unit_price_cents)}</div></td>
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
    <div class="main-t"><div class="t">${client.name}</div><div class="s">${client.address || 'No address'}</div></div>${chev()}</a></div>
  <h2>Scope of work</h2><div class="card pre">${estimate.scope || html`<span class="muted">—</span>`}</div>
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
    ${locked ? '' : html`<a class="btn secondary" href="/estimates/${estimate.id}/edit">Edit estimate</a>
    <a class="btn danger" href="/estimates/${estimate.id}/delete">Delete</a>`}</div>
  ${emailHistory(emails)}
  <p class="hint">The PDF and the client's page show your company profile, the client, scope and line items. Your internal cost and profit are never included.</p>
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
    <div class="muted">Prepared for <strong style="color:var(--text)">${client.name}</strong>${client.address ? ` · ${client.address}` : ''}</div>
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
  ${estimate.scope ? html`<h2>Scope of work</h2><div class="card pre">${estimate.scope}</div>` : ''}
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
        <ul>${g.items.map((i) => html`<li>${i.description}${Number(i.qty_hundredths) !== 100 ? html` <span class="muted">× ${fmtQty(i.qty_hundredths)}</span>` : ''}</li>`)}</ul>
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
  <p class="pub-foot">Sent with Vista</p>
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
function calendar({ month, day, today, byDay }) {
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
      <a class="prev" href="/jobs?month=${prevMonth}" aria-label="Previous month">${icon('chev', 'sm')}</a>
      <strong>${LONG_MONTHS[m - 1]} ${y}</strong>
      <span class="row" style="gap:6px">${today.slice(0, 7) !== month || day !== today ? html`<a class="today-link" href="/jobs">Today</a>` : ''}
        <a href="/jobs?month=${nextMonth}" aria-label="Next month">${icon('chev', 'sm')}</a></span>
    </div>
    <div class="cal-grid">
      ${DOW.map((d) => html`<div class="cal-dow">${d.slice(0, 1)}</div>`)}
      ${cells.map((d) => {
        const st = byDay[d] || [];
        const cls = [d.slice(0, 7) !== month ? 'out' : '', d === today ? 'today' : '', d === day ? 'sel' : ''].join(' ');
        return html`<a class="cal-day ${cls}" href="/jobs?day=${d}" aria-label="${d}${st.length ? `, ${st.length} job${st.length > 1 ? 's' : ''}` : ''}">
          <span class="n">${Number(d.slice(8))}</span><span class="cal-dots">${st.slice(0, 3).map((x) => html`<i class="${x}"></i>`)}</span></a>`;
      })}
    </div>
  </div>`;
}

function jobsPage({ jobs, status, cal }) {
  const [y, m, d] = cal.day.split('-').map(Number);
  const dayName = DOW[new Date(cal.day + 'T00:00:00Z').getUTCDay()];
  return layout('Jobs', html`
  ${calendar(cal)}
  <h2 id="day-jobs">${cal.day === cal.today ? 'Today' : dayName}, ${MONTHS[m - 1]} ${d}${y !== Number(cal.today.slice(0, 4)) ? `, ${y}` : ''}</h2>
  ${jobList(cal.dayJobs, 'No jobs scheduled this day.')}
  <h2>All jobs</h2>
  ${chips('/jobs', JOB_STATUS, status)}${jobList(jobs, 'No jobs.')}`);
}

function jobPage({ job, client, expenses, payments, crew = [], members = [], invoices = [], invoicing = {}, forms = {}, emails = [], flash }) {
  const jf = forms.job || { values: { status: job.status, start_date: job.start_date || '', end_date: job.end_date || '', notes: job.notes }, errors: {} };
  const ef = forms.expense || { values: {}, errors: {} };
  const pf = forms.payment || { values: { paid_on: new Intl.DateTimeFormat('en-CA', { timeZone: process.env.APP_TIMEZONE || 'America/Los_Angeles' }).format(new Date()) }, errors: {} };
  const af = forms.assign || { values: {}, errors: {} };
  const vf = forms.invoice || { values: {}, errors: {} };
  const final = job.status === 'completed';
  return layout(job.project_name, html`
  <p style="margin:0 2px 14px">${pill(job.status, JOB_STATUS)} ${dateRange(job.start_date, job.end_date) ? html`<span class="muted" style="margin-left:6px">${dateRange(job.start_date, job.end_date)}</span>` : ''}</p>
  ${errorBox({ ...jf.errors, ...ef.errors, ...pf.errors, ...af.errors, ...vf.errors })}
  <div class="stats" id="job-summary">
    <div class="stat"><div class="k">Contract total</div><div class="v" data-k="contract">${fmt(job.contract_cents)}</div></div>
    <div class="stat"><div class="k">Outstanding</div><div class="v" data-k="balance">${fmt(job.balance_cents)}</div></div>
    <div class="stat"><div class="k">Payments received</div><div class="v" data-k="payments">${fmt(job.payments_cents)}</div></div>
    <div class="stat"><div class="k">Expenses</div><div class="v" data-k="expenses">${fmt(job.expenses_cents)}</div></div>
    <div class="stat"><div class="k">Worker payouts</div><div class="v" data-k="payouts">${fmt(job.payouts_cents)}</div></div>
    <div class="stat ${job.gross_profit_cents >= 0 ? 'good' : 'bad'}"><div class="k">Gross profit ${final ? '(final)' : '(provisional)'}</div>
      <div class="v" data-k="profit">${fmt(job.gross_profit_cents)}</div>
      <div class="s">Contract − expenses − payouts${final ? '' : '. Provisional until completed.'}</div></div>
  </div>

  <div class="list">
    <a class="li" href="/clients/${client.id}"><span class="icon-bubble">${icon('users')}</span><div class="main-t"><div class="s">Client</div><div class="t">${client.name}</div></div>${chev()}</a>
    ${job.address ? html`<a class="li" href="https://maps.google.com/?q=${encodeURIComponent(job.address)}"><span class="icon-bubble">${icon('pin')}</span><div class="main-t"><div class="s">Job address</div><div class="t">${job.address}</div></div></a>` : ''}
    <a class="li" href="/estimates/${job.estimate_id}"><span class="icon-bubble">${icon('file')}</span><div class="main-t"><div class="s">Original estimate</div><div class="t">View estimate</div></div>${chev()}</a>
  </div>
  <h2>Scope of work</h2><div class="card pre">${job.scope || html`<span class="muted">—</span>`}</div>
  <div class="actions"><a class="btn secondary" href="/jobs/${job.id}/work-order" id="work-order">${icon('download')}Work order PDF</a></div>

  <h2>Job details</h2>
  <form method="post" action="/jobs/${job.id}" class="form-card" novalidate>
    <label for="status">Status</label><select id="status" name="status">${options(JOB_STATUS, jf.values.status)}</select>
    <div class="two">
      <div>${input('start_date', 'Start date', jf.values, jf.errors, { type: 'date' })}</div>
      <div>${input('end_date', 'End date', jf.values, jf.errors, { type: 'date' })}</div>
    </div>
    ${textarea('notes', 'Notes', jf.values, jf.errors, { placeholder: 'Gate codes, materials, reminders…' })}
    <div class="form-actions"><button type="submit">Save job details</button></div>
  </form>

  <h2>Workers & payouts</h2>
  ${crew.length ? html`<div class="list">${crew.map((c) => html`<div class="li">
    <span class="avatar">${initialOf(c)}</span>
    <div class="main-t"><div class="t">${who(c)}</div><div class="s">${c.role === 'removed' ? 'No longer on team' : ROLES[c.role]}</div></div>
    <div class="r"><span class="amt">${fmt(c.payout_cents)}</span><span style="font-size:14px"><a href="/jobs/${job.id}/work-order?user_id=${c.user_id}">Work order</a> · <a href="/jobs/${job.id}/assignments/remove?user_id=${c.user_id}">Remove</a></span></div>
  </div>`)}</div>` : html`<div class="empty">Nobody assigned yet.</div>`}
  ${members.length ? html`<form method="post" action="/jobs/${job.id}/assignments" class="form-card" novalidate>
    <div class="two stack"><div><label for="assign_user">Person</label>
      <select id="assign_user" name="user_id" class="${inv(af.errors, 'user_id')}">
        <option value="">Choose…</option>${members.map((m) => html`<option value="${m.user_id}" ${af.values.user_id === m.user_id ? raw('selected') : ''}>${who(m)} (${ROLES[m.role]})</option>`)}
      </select>${fieldErr(af.errors, 'user_id')}</div>
    <div>${input('payout', 'Payout ($)', af.values, af.errors, { required: true, inputmode: 'decimal' })}</div></div>
    <div class="hint">What they'll be paid for this job. They see only their own amount. Records only; nothing is paid through the app.</div>
    <div class="form-actions"><button type="submit" class="secondary">Assign / update payout</button></div>
  </form>` : ''}

  <h2>Expenses</h2>
  ${entryList(expenses, 'expenses', (e) => e.description, 'No expenses recorded.')}
  <form method="post" action="/jobs/${job.id}/expenses" class="form-card" novalidate>
    <div class="two stack"><div>${input('description', 'Expense description', ef.values, ef.errors, { required: true })}</div>
    <div>${input('amount', 'Amount ($)', ef.values, ef.errors, { required: true, inputmode: 'decimal' })}</div></div>
    <div class="form-actions"><button type="submit" class="secondary">Add expense</button></div>
  </form>

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
    <div class="two stack"><div>${input('invoice_amount', 'Amount ($)', values, vf.errors, { required: true, inputmode: 'decimal', hint: `Outstanding: ${fmt(job.balance_cents)}` })}</div>
    <div><label for="days">Payment due</label><select id="days" name="days">${options({ 0: 'On receipt', 7: 'In 7 days', 14: 'In 14 days', 30: 'In 30 days' }, String(values.days))}</select></div></div>
    ${input('invoice_email', 'Send to', values, vf.errors, { type: 'email', required: true, inputmode: 'email' })}
    ${input('invoice_desc', 'Description on the invoice', values, vf.errors)}
    <div class="form-actions"><button type="submit">Send invoice</button></div>
  </form>`;
}
const plainCents = (c) => `${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`;

function entryList(rows, kind, title, empty) {
  if (!rows.length) return html`<div class="empty">${empty}</div>`;
  return html`<div class="list">${rows.map((r) => html`<div class="li">
    <div class="main-t"><div class="t">${title(r)}</div>
      <div class="s"><a href="/${kind}/${r.id}/edit">Edit</a> · <a href="/${kind}/${r.id}/delete">Delete</a></div></div>
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
    </div>
    <div class="form-actions"><a class="btn secondary" href="/jobs/${job.id}">Cancel</a><button type="submit">Save</button></div>
  </form>`, { back: { href: `/jobs/${job.id}`, label: job.project_name }, sub: html`For ${job.project_name}` });
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
  ESTIMATE_STATUS, JOB_STATUS, nav, publicEstimatePage, schedulePage, scheduleJobPage, confirmPage, loginPage, signupPage, welcomePage,
  accountPage, billingPage, teamPage, memberPage, settingsPage, homePage, clientsPage, clientFormPage, clientPage, estimatesPage, estimateFormPage, estimatePage,
  jobsPage, jobPage, entryFormPage, confirmDeletePage, messagePage,
};
