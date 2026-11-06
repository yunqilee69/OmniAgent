export const WEB_CLIENT_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light dark" />
<title>OmniAgent Workbench</title>
<style>
:root{color-scheme:light;--bg:#fff;--surface:#fff;--side:#f9fafb;--raised:#f4f5f7;--input:#fff;--bubble:#edf3fe;--hover:rgba(38,49,72,.06);--active:rgba(38,49,72,.1);--line:rgba(0,0,0,.1);--line-soft:rgba(0,0,0,.06);--ink:#0f1115;--muted:#61666b;--soft:#81858c;--accent:#4176e6;--accent-soft:#edf3fe;--accent-ink:#315ec2;--amber:#a3620a;--amber-soft:#fdf1db;--red:#c43d3b;--red-soft:#fcebea;--green:#288456;--shadow:0 12px 40px rgba(0,0,0,.16);--composer-shadow:0 0 0 1px var(--line),0 4px 16px rgba(0,0,0,.04)}
:root[data-theme="dark"]{color-scheme:dark;--bg:#151517;--surface:#232324;--side:#1b1b1c;--raised:#2c2c2e;--input:#2c2c2e;--bubble:#2c2c2e;--hover:rgba(255,255,255,.08);--active:rgba(255,255,255,.14);--line:rgba(255,255,255,.12);--line-soft:rgba(255,255,255,.06);--ink:#f9fafb;--muted:#cfd3d6;--soft:#adb2b8;--accent:#7aaaff;--accent-soft:#25354e;--accent-ink:#a7c7ff;--amber:#e7b66a;--amber-soft:#423522;--red:#f18e8b;--red-soft:#492b2b;--green:#71c99a;--shadow:0 12px 40px rgba(0,0,0,.4);--composer-shadow:0 0 0 1px var(--line),0 4px 16px rgba(0,0,0,.18)}
*{box-sizing:border-box}html,body{height:100%;margin:0}body{background:var(--bg);color:var(--ink);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif}button,input,textarea,select{font:inherit;color:inherit}button{border:0;cursor:pointer}button:disabled{cursor:not-allowed;opacity:.48}button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible,summary:focus-visible,[tabindex]:focus-visible{outline:2px solid var(--accent);outline-offset:2px}[hidden]{display:none!important}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}.muted{color:var(--muted)}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}.icon{display:block;width:16px;height:16px;flex:none}.icon-sprite{position:absolute;width:0;height:0;overflow:hidden}::-webkit-scrollbar{width:5px;height:5px}::-webkit-scrollbar-thumb{background:var(--line);border-radius:5px}
.app{height:100dvh;min-height:0;display:grid;grid-template-columns:280px minmax(0,1fr);overflow:hidden}.sidebar{z-index:5;min-height:0;display:flex;flex-direction:column;background:var(--side);border-right:1px solid var(--line-soft)}.brand-row{height:58px;display:flex;align-items:center;gap:10px;padding:0 17px;flex:none}.brand-mark{display:grid;place-items:center;width:27px;height:27px;color:var(--accent);font-size:22px;line-height:1}.brand-name{font-size:15px;font-weight:650}.brand-sub{color:var(--soft);font-size:10px}.sidebar-body{padding:4px 8px 10px;display:flex;flex-direction:column;gap:16px;min-height:0;flex:1}.side-section{min-width:0}.section-label{display:flex;align-items:center;justify-content:space-between;min-height:28px;margin:0 8px 4px;color:var(--soft);font-size:12px;font-weight:600}.workspace-controls{display:flex;gap:4px}.workspace-select{min-width:0;flex:1;height:34px;padding:0 8px;border:1px solid var(--line);border-radius:6px;background:var(--surface);font-size:13px;font-weight:500}.icon-button{display:inline-grid;place-items:center;width:32px;height:32px;flex:none;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--muted)}.icon-button:hover:not(:disabled){background:var(--hover);color:var(--ink)}.workspace-controls .icon-button{height:34px}.workspace-path{display:block;margin:6px 9px 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--soft);font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}.new-session{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;min-height:38px;border:1px solid var(--line);border-radius:8px;background:var(--surface);font-size:13px;font-weight:600}.new-session:hover:not(:disabled){background:var(--hover)}.sessions-section{display:flex;flex-direction:column;min-height:0;flex:1}.search-wrap{position:relative;min-width:0;flex:none}.search-icon{position:absolute;left:10px;top:10px;color:var(--soft);pointer-events:none}.search-icon .icon{width:14px;height:14px}.search{width:100%;height:34px;padding:0 10px 0 31px;border:1px solid var(--line);border-radius:6px;background:var(--surface);font-size:12px}.session-list{display:flex;flex-direction:column;gap:2px;overflow:auto;margin:8px -4px 0;padding:0 4px 8px;min-height:0}.session-button{display:grid;grid-template-columns:17px minmax(0,1fr);align-items:start;gap:7px;width:100%;padding:8px 9px;text-align:left;border-radius:6px;background:transparent}.session-button:hover:not(:disabled){background:var(--hover)}.session-button.active{background:var(--active)}.session-glyph{color:var(--soft);font-size:15px;line-height:19px}.session-name{display:block;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:13px;font-weight:500}.session-meta{display:block;overflow:hidden;margin-top:2px;color:var(--soft);font-size:10px;white-space:nowrap;text-overflow:ellipsis}.side-empty{padding:12px 8px;color:var(--soft);font-size:12px}.sidebar-footer{display:flex;align-items:center;justify-content:space-between;padding:9px 14px;border-top:1px solid var(--line-soft);color:var(--soft);font-size:11px;flex:none}.local-badge{display:flex;align-items:center;gap:7px}.local-dot,.status-dot{width:6px;height:6px;border-radius:50%;background:var(--green);flex:none}.theme-button{width:30px;height:30px}
.main{min-width:0;min-height:0;display:flex;flex-direction:column;background:var(--bg)}.topbar{height:52px;display:flex;align-items:center;gap:12px;padding:0 24px;background:var(--bg);flex:none}.drawer-button{display:none}.breadcrumbs{display:flex;align-items:center;gap:9px;min-width:0;flex:1;font-size:13px}.crumb-workspace,.crumb-session{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.crumb-workspace{max-width:35%;color:var(--muted)}.crumb-session{font-weight:600}.crumb-slash{color:var(--soft)}.status{display:flex;align-items:center;gap:7px;white-space:nowrap;color:var(--muted);font-size:11px;font-weight:500}.status.running{color:var(--amber)}.status.running .status-dot{background:var(--amber);box-shadow:0 0 0 3px var(--amber-soft)}.status.error{color:var(--red)}.status.error .status-dot{background:var(--red)}.status.interrupted{color:var(--amber)}.status.interrupted .status-dot{background:var(--amber)}.tabs{height:40px;display:flex;align-items:stretch;gap:28px;padding:0 24px;border-bottom:1px solid var(--line-soft);background:var(--bg);flex:none}.tab{position:relative;padding:0 1px;border-radius:0;background:transparent;color:var(--muted);font-size:13px;font-weight:500}.tab:hover{color:var(--ink)}.tab[aria-selected="true"]{color:var(--accent)}.tab[aria-selected="true"]:after{content:"";position:absolute;right:0;bottom:-1px;left:0;height:2px;background:var(--accent)}.tab-count{margin-left:5px;color:var(--soft);font:10px ui-monospace,SFMono-Regular,Menlo,monospace}.alert{display:flex;align-items:center;gap:10px;margin:12px 22px 0;padding:9px 10px 9px 12px;border-radius:6px;background:var(--red-soft);color:var(--red);font-size:12px;flex:none}.alert span{flex:1;overflow-wrap:anywhere}.alert .icon-button{width:24px;height:24px;color:inherit}
.view{min-height:0;min-width:0;flex:1}.conversation-view{display:flex;flex-direction:column}.transcript-scroll{flex:1;min-height:0;overflow:auto;scrollbar-gutter:stable}.transcript{width:min(812px,100%);margin:0 auto;padding:28px 32px 32px}.transcript:has(.empty-state){min-height:100%;display:flex;align-items:center;justify-content:center}.conversation-heading{margin-bottom:26px;color:var(--soft);font-size:11px;font-weight:600}.message{display:flex;flex-direction:column;align-items:flex-start;gap:6px;margin-bottom:24px}.avatar{display:none}.message-content{max-width:100%;min-width:0}.message-label{margin-bottom:5px;color:var(--soft);font-size:11px;font-weight:600}.message-body{white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px;line-height:24px}.message.user{align-items:flex-end}.message.user .message-content{max-width:min(70.2%,82%)}.message.user .message-label{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}.message.user .message-body{padding:10px 16px;border-radius:20px;background:var(--bubble);line-height:22px}.message.notice .message-body{color:var(--red)}.tool-row{margin:0 0 12px;border:0;border-radius:6px;background:transparent;font-size:12px}.tool-row summary{display:flex;align-items:center;gap:8px;min-height:30px;padding:3px 7px;color:var(--muted);cursor:pointer;list-style:none}.tool-row summary:hover{background:var(--hover)}.tool-row summary::-webkit-details-marker{display:none}.tool-row summary:before{content:"›";color:var(--soft);font-size:18px;line-height:1;transition:transform .15s}.tool-row[open] summary:before{transform:rotate(90deg)}.tool-name{overflow-wrap:anywhere;font-weight:600}.tool-label{margin-right:auto;color:var(--soft)}.tool-status{padding:2px 6px;border-radius:4px;background:var(--amber-soft);color:var(--amber);font-size:10px;font-weight:600;white-space:nowrap}.tool-status.ok{background:transparent;color:var(--green)}.tool-status.failed{background:var(--red-soft);color:var(--red)}.tool-details{margin:2px 0 0 20px;padding:10px 12px;border-left:1px solid var(--line);color:var(--muted)}.tool-details h4{margin:0 0 5px;font-size:10px;text-transform:uppercase}.tool-details pre{margin:0 0 12px;color:var(--ink);white-space:pre-wrap;overflow-wrap:anywhere;font:11px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace}.tool-details pre:last-child{margin-bottom:0}.empty-state{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:220px;padding:24px;text-align:center;color:var(--muted)}.empty-icon{display:grid;place-items:center;width:44px;height:44px;margin-bottom:16px;color:var(--accent);font-size:27px}.empty-state strong{color:var(--ink);font-size:18px;font-weight:600}.empty-state p{max-width:330px;margin:7px 0 0;font-size:13px;line-height:1.6}.empty-state button{margin-top:16px}.primary,.secondary,.danger{padding:9px 13px;border-radius:6px;font-size:12px;font-weight:600}.primary{background:var(--ink);color:var(--bg)}.secondary{border:1px solid var(--line);background:var(--surface)}.danger{background:var(--red);color:#fff}.composer-area{background:var(--bg);flex:none}.composer-inner{width:min(844px,100%);margin:auto;padding:12px 32px 16px}.composer-box{display:flex;flex-direction:column;border-radius:22px;background:var(--input);box-shadow:var(--composer-shadow)}.composer-box:focus-within{box-shadow:0 0 0 1px var(--accent),0 4px 16px rgba(0,0,0,.04)}.composer-box textarea{display:block;width:100%;min-height:64px;max-height:180px;resize:vertical;padding:15px 16px 4px;border:0;outline:none;background:transparent;font-size:14px;line-height:24px}.composer-actions{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:4px 8px 8px 16px;color:var(--soft);font-size:11px}.composer-actions .controls{display:flex;gap:6px}.send-button,.stop-button{display:grid;place-items:center;width:34px;height:34px;padding:0;border-radius:50%}.send-button{background:var(--accent);color:#fff}.stop-button{background:var(--red-soft);color:var(--red)}.composer-note{overflow:hidden;margin:8px 5px 0;color:var(--soft);font-size:10px;text-overflow:ellipsis;white-space:nowrap}
.observe-view{display:flex;min-width:0}.ledger{display:flex;flex-direction:column;min-width:0;flex:1}.ledger-toolbar{display:flex;align-items:center;gap:8px;min-height:64px;padding:12px 18px;border-bottom:1px solid var(--line-soft);flex-wrap:wrap}.ledger-title{min-width:120px;margin-right:auto}.ledger-title strong{display:block;font-size:13px;font-weight:600}.ledger-title span{display:block;margin-top:2px;color:var(--soft);font-size:11px}.filter-select{height:32px;padding:0 8px;border:1px solid var(--line);border-radius:6px;background:var(--surface);font-size:12px}.ledger-search{width:180px;height:32px}.ledger-toolbar .search-icon{top:9px}.table-scroll{overflow:auto;min-height:0;flex:1}.event-table{width:100%;min-width:500px;border-collapse:collapse;table-layout:fixed;text-align:left;font-size:12px;line-height:18px}.event-table th{position:sticky;top:0;z-index:1;height:30px;padding:0 10px;border-bottom:1px solid var(--line);background:var(--side);color:var(--soft);font-size:11px;font-weight:500}.event-table td{height:30px;padding:0 10px;overflow:hidden;border-bottom:1px solid var(--line-soft);text-overflow:ellipsis;white-space:nowrap}.event-table tbody tr{cursor:pointer}.event-table tbody tr:hover{background:var(--hover)}.event-table tbody tr[aria-selected="true"]{background:var(--active);box-shadow:inset 3px 0 var(--accent)}.event-table th:nth-child(1){width:100px}.event-table th:nth-child(2){width:52px}.event-table th:nth-child(3){width:150px}.event-type{color:var(--ink);font-weight:600}.event-info{color:var(--muted)}.ledger-empty{padding:48px 20px;text-align:center;color:var(--soft);font-size:12px}.inspector{width:clamp(270px,30%,360px);min-width:0;overflow:auto;border-left:1px solid var(--line-soft);background:var(--bg);flex:none}.inspector-header{padding:14px 18px;border-bottom:1px solid var(--line-soft)}.inspector-header strong{display:block;font-size:12px;font-weight:600}.inspector-header span{display:block;margin-top:2px;color:var(--soft);font-size:11px}.inspector-body{padding:18px}.inspector-placeholder{color:var(--soft);font-size:12px;line-height:1.6}.inspector-type{display:inline-block;max-width:100%;padding:4px 7px;border-radius:4px;background:var(--accent-soft);color:var(--accent-ink);overflow-wrap:anywhere;font:600 11px ui-monospace,SFMono-Regular,Menlo,monospace}.inspector-caption{margin:22px 0 9px;color:var(--soft);font-size:10px;font-weight:600;text-transform:uppercase}.metadata-row{padding:9px 0;border-top:1px solid var(--line-soft)}.metadata-row dt{margin-bottom:4px;color:var(--soft);font-size:10px}.metadata-row dd{margin:0;overflow-wrap:anywhere;font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}.drawer-backdrop{display:none}
dialog{width:min(440px,calc(100% - 32px));padding:0;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--ink);box-shadow:var(--shadow)}dialog::backdrop{background:rgba(0,0,0,.48)}.dialog-head{display:flex;align-items:center;justify-content:space-between;padding:18px 20px;border-bottom:1px solid var(--line-soft)}.dialog-head h2{margin:0;font-size:15px}.dialog-body{padding:18px 20px}.dialog-body p{margin:0 0 16px;color:var(--muted);font-size:12px;line-height:1.6;overflow-wrap:anywhere}.field{display:block;margin-top:14px;font-size:11px;font-weight:600}.field:first-child{margin-top:0}.field input{display:block;width:100%;height:38px;margin-top:6px;padding:0 10px;border:1px solid var(--line);border-radius:6px;background:var(--bg);font-size:12px}.field-hint{display:block;margin-top:5px;color:var(--muted);font-size:11px;font-weight:400}.dialog-error{margin-top:12px;color:var(--red);font-size:12px;overflow-wrap:anywhere}.dialog-actions{display:flex;justify-content:flex-end;gap:8px;padding:0 20px 20px}
@media(max-width:1100px){.inspector{width:270px}.ledger-search{width:150px}}
@media(max-width:767px){.app{grid-template-columns:minmax(0,1fr)}.sidebar{position:fixed;top:0;bottom:0;left:0;width:min(280px,calc(100vw - 48px));transform:translateX(-105%);visibility:hidden;transition:transform .2s,visibility .2s;box-shadow:var(--shadow)}.app.drawer-open .sidebar{transform:translateX(0);visibility:visible}.drawer-button{display:inline-grid;margin-left:-8px}.drawer-backdrop{position:fixed;inset:0;z-index:4;background:rgba(0,0,0,.48);border-radius:0}.app.drawer-open .drawer-backdrop{display:block}.topbar{padding:0 16px;gap:8px}.tabs{padding:0 18px}.transcript{padding:24px 20px 28px}.composer-inner{padding:10px 16px 14px}.message.user .message-content{max-width:85%}.inspector{width:250px}}
@media(max-width:1050px){.observe-view{flex-direction:column;overflow:auto}.ledger{min-height:280px;flex:none}.table-scroll{max-height:48vh}.inspector{width:100%;overflow:visible;border-top:1px solid var(--line-soft);border-left:0}.inspector-header{padding:12px 16px}.inspector-body{padding:14px 16px}.ledger-toolbar{padding:12px 16px}.ledger-title{width:100%}.ledger-toolbar .search-wrap{min-width:100px;flex:1}.ledger-search{width:100%}.crumb-workspace{max-width:38%}.alert{margin:10px 12px 0}.event-table th:nth-child(1){width:95px}.event-table th:nth-child(3){width:140px}}
/* DSH sidebar, conversation header, trajectory overview, and settings geometry. */
.brand-row{height:60px;padding:8px 8px 8px 16px}.brand-name{font-size:17px;flex:1}.sidebar-body{padding:0 8px 8px;gap:12px}.new-session{width:calc(100% - 8px);margin:0 4px;min-height:38px;font-size:14px}.section-label{margin:0 4px 4px 12px;min-height:36px;font-weight:500}.section-label>span:last-child{display:flex}.section-label .icon-button{width:28px;height:28px}.workspace-tree{margin-top:8px;overflow:auto;min-height:0}.workspace-row{display:flex;align-items:center;gap:6px;width:100%;height:32px;padding:0 8px;border-radius:6px;background:transparent;text-align:left;color:var(--ink)}.workspace-row:hover{background:var(--hover)}.workspace-caret{width:12px;color:var(--soft);font-size:11px}.workspace-folder{color:var(--muted)}.workspace-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}.session-list{margin:0 0 4px 20px;overflow:visible;padding:0}.session-button{padding:6px 8px;gap:4px}.session-meta{display:none}.sidebar-footer{gap:4px;padding:6px 10px;border:0}.settings-button{display:flex;align-items:center;gap:10px;min-width:0;flex:1;height:36px;padding:0 10px;border-radius:6px;background:transparent;text-align:left}.settings-button:hover{background:var(--hover)}.sidebar-toggle{margin-left:auto}.tabs{height:34px;gap:32px;padding:0 28px}.session-menu{position:relative;margin-left:0;align-self:center}.session-menu .icon-button{width:26px;height:26px}.menu-surface{position:absolute;z-index:12;top:30px;left:0;min-width:230px;padding:5px;border:1px solid var(--line);border-radius:6px;background:var(--surface);box-shadow:var(--shadow)}.menu-surface button{display:block;width:100%;padding:8px 10px;border-radius:4px;background:transparent;text-align:left;white-space:nowrap;font-size:12px}.menu-surface button:hover,.menu-surface button:focus-visible{background:var(--hover)}
.export-disclosure{max-width:240px;margin:4px 10px 6px;color:var(--muted);font-size:11px;line-height:1.5}
.composer-footer{display:flex;align-items:center;gap:8px;margin:6px 4px 0}.composer-footer .composer-note{margin:0;min-width:0}.permission-entry{padding:3px 6px;border-radius:4px;background:transparent;color:var(--muted);font-size:11px;white-space:nowrap}.permission-entry:hover{background:var(--hover)}.approval-seat{width:min(812px,100%);margin:0 auto;padding:0 32px}.approval{padding:12px 14px;border:1px solid var(--line);border-radius:8px;background:var(--surface);box-shadow:var(--composer-shadow)}.approval-head,.approval-actions{display:flex;align-items:center;gap:10px}.approval-head strong{font-size:13px}.approval-head span{color:var(--muted);overflow-wrap:anywhere}.approval p{margin:7px 0;color:var(--muted);font-size:12px;overflow-wrap:anywhere}.approval-label{color:var(--soft);font-size:11px}.approval pre{max-height:120px;margin:4px 0 10px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font:11px/1.5 ui-monospace,monospace}.approval-actions{justify-content:flex-end}
.timeline{display:grid;grid-template-columns:44px minmax(0,1fr);height:50px;flex:none;border-bottom:1px solid var(--line);background:var(--side)}.timeline-labels{display:grid;grid-template-rows:repeat(3,14px);align-content:center;padding-right:4px;border-right:1px solid var(--line);color:var(--soft);text-align:right;font-size:10px;line-height:14px}.timeline-track{position:relative;min-width:0;overflow:hidden}.timeline-span{position:absolute;height:8px;min-width:3px;padding:0;border-radius:1px;background:var(--accent);opacity:.8}.timeline-span.input{top:7px;background:var(--accent)}.timeline-span.model{top:21px;background:#a2678c}.timeline-span.tools{top:35px;background:var(--amber)}.timeline-span.selected{outline:2px solid var(--accent);outline-offset:1px;opacity:1;z-index:1}.timeline-empty{position:absolute;top:16px;left:12px;color:var(--soft);font-size:11px}.event-table{min-width:360px}.event-table th:nth-child(1){width:90px}.event-table th:nth-child(2){width:52px}.event-table th:nth-child(3){width:auto}.event-table th:nth-child(4){width:95px}.event-kind{font-weight:600}.event-kind.input{color:var(--accent)}.event-kind.model{color:#a2678c}.event-kind.tool{color:var(--amber)}
.trajectory-segments{display:inline-flex;flex:none;padding:2px;border:1px solid var(--line);border-radius:6px;background:var(--side)}.trajectory-segments button{min-height:26px;padding:0 9px;border-radius:4px;background:transparent;color:var(--muted);font-size:12px;font-weight:500}.trajectory-segments button:hover{color:var(--ink)}.trajectory-segments button[aria-pressed="true"]{background:var(--surface);color:var(--ink);box-shadow:0 0 0 1px var(--line-soft)}.event-kind.audit{color:var(--green)}.event-kind.errors{color:var(--red)}.event-info{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;font-weight:400}
.settings-dialog{width:min(900px,calc(100% - 32px));height:min(680px,calc(100% - 32px));max-height:calc(100% - 32px)}.settings-shell{display:flex;height:100%;min-height:0}.settings-nav{width:210px;flex:none;padding:24px 12px;background:var(--side);border-right:1px solid var(--line-soft)}.settings-nav h2{margin:0 10px 24px;font-size:16px}.settings-nav button{display:flex;align-items:center;gap:9px;width:100%;padding:9px 10px;border-radius:6px;background:var(--active);text-align:left;font-size:13px;font-weight:600}.settings-content{flex:1;min-width:0;overflow:auto}.settings-head{display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:2;padding:18px 28px;background:var(--surface);border-bottom:1px solid var(--line-soft)}.settings-head h2{margin:0;font-size:16px}
.settings-content .permission-settings{max-width:620px;margin:0 auto;padding:24px 28px}.permission-row{display:flex;align-items:center;gap:8px;padding:16px 0;border-bottom:1px solid var(--line-soft)}.permission-row-text{flex:1;min-width:0;padding-right:36px}.permission-row-title{font-size:14px;line-height:22px}.permission-row-description,.permission-explanation{margin:4px 0 0;color:var(--muted);font-size:12px;line-height:18px}.permission-explanation{margin-top:18px}.permission-picker{position:relative;flex:none}.permission-selector{display:inline-flex;align-items:center;gap:12px;min-height:36px;padding:0 12px;border-radius:6px;background:var(--raised);font-size:13px}.permission-selector:hover:not(:disabled){background:var(--active)}.permission-selector .icon{width:14px;height:14px}.permission-menu{position:absolute;z-index:15;right:0;top:calc(100% + 4px);width:220px;padding:4px;border:1px solid var(--line);border-radius:6px;background:var(--surface);box-shadow:var(--shadow)}.permission-menu button{display:flex;align-items:center;gap:8px;width:100%;min-height:34px;padding:6px 9px;border-radius:4px;background:transparent;text-align:left;font-size:12px}.permission-menu button:hover,.permission-menu button:focus-visible{background:var(--hover)}.permission-menu button[aria-checked="true"]{font-weight:600}.permission-menu button[aria-checked="true"]:after{content:'✓';margin-left:auto;color:var(--accent)}.permission-entry{display:inline-flex;align-items:center;gap:4px;min-width:0;max-width:220px;height:28px;padding:0 4px 0 8px;border-radius:4px;background:transparent;color:var(--muted);font-size:13px;font-weight:500}.permission-entry:hover:not(:disabled){background:var(--hover)}.permission-entry .icon{width:14px;height:14px}.permission-entry span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.session-permission-menu{top:auto;right:auto;bottom:calc(100% + 4px);left:0}.composer-meta{display:flex;align-items:center;gap:8px;min-width:0}.composer-meta #composer-state{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.session-permission-error{margin:5px 5px 0;color:var(--red);font-size:11px;overflow-wrap:anywhere}.session-agent-error,.session-model-error{margin:5px 5px 0;color:var(--red);font-size:11px;overflow-wrap:anywhere}.agent-picker{min-width:0}.agent-select{max-width:190px;height:28px;padding:0 6px;border:0;border-radius:4px;background:transparent;color:var(--muted);font:11px/1.4 inherit;text-overflow:ellipsis}.agent-select:hover:not(:disabled){background:var(--hover)}.model-picker{min-width:0}.model-select{max-width:230px;height:28px;padding:0 6px;border:0;border-radius:4px;background:transparent;color:var(--muted);font:11px/1.4 inherit;text-overflow:ellipsis}.model-select:hover:not(:disabled){background:var(--hover)}.risk-ack{display:flex;align-items:flex-start;gap:8px;padding:10px;border-radius:6px;background:var(--amber-soft);color:var(--amber);font-size:12px}.risk-ack input{margin-top:3px}.risk-confirm{margin-top:16px}.permission-status{margin-top:10px;color:var(--green);font-size:12px}.permission-settings .dialog-error{margin-top:10px}
@media(max-width:767px){.settings-content .permission-settings{padding:18px}.permission-row-text{padding-right:8px}.permission-menu{max-width:calc(100vw - 48px)}.composer-meta #composer-state{display:none}}
@media(min-width:768px) and (max-width:1023px){.app:not(.sidebar-expanded){grid-template-columns:56px minmax(0,1fr)}.app:not(.sidebar-expanded) .sidebar{padding:18px 10px 6px}.app:not(.sidebar-expanded) .brand-row{height:36px;padding:0;margin-bottom:12px}.app:not(.sidebar-expanded) .brand-mark,.app:not(.sidebar-expanded) .brand-name,.app:not(.sidebar-expanded) .new-session span,.app:not(.sidebar-expanded) .sessions-section,.app:not(.sidebar-expanded) .settings-button span,.app:not(.sidebar-expanded) .theme-button{display:none}.app:not(.sidebar-expanded) .sidebar-toggle,.app:not(.sidebar-expanded) .new-session,.app:not(.sidebar-expanded) .settings-button{width:36px;height:36px;min-height:36px;margin:0;padding:0;border:0;background:transparent;justify-content:center}.app:not(.sidebar-expanded) .sidebar-body{padding:0;flex:1}.app:not(.sidebar-expanded) .sidebar-footer{padding:0}.app:not(.sidebar-expanded) .settings-button{flex:none}}
.approval-seat{order:1}.composer-area{order:2}
@media(max-width:767px){.sidebar-toggle{display:none}.settings-dialog{width:calc(100% - 16px);height:calc(100% - 16px);max-height:calc(100% - 16px)}.settings-shell{flex-direction:column}.settings-nav{width:100%;display:flex;align-items:center;gap:18px;padding:12px;border-right:0;border-bottom:1px solid var(--line)}.settings-nav h2{margin:0;font-size:15px}.settings-nav button{width:auto;padding:7px 9px}.settings-content form{padding:18px}.settings-head{padding:12px 18px}.approval-seat{padding:0 16px}.composer-footer .composer-note{display:none}.tabs{padding:0 18px}.timeline-span{min-width:6px}}
:root[data-theme="dark"] .send-button{color:#151517}
@media(pointer:coarse){.composer-box textarea{font-size:16px}}
@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important}}
.plan-toggle{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 8px;border-radius:4px;background:transparent;color:var(--muted);font-size:11px;font-weight:600;white-space:nowrap}.plan-toggle:hover:not(:disabled){background:var(--hover)}.plan-toggle[aria-pressed="true"]{background:var(--accent-soft);color:var(--accent-ink)}.plan-toggle:before{content:"";width:6px;height:6px;border-radius:50%;border:1.5px solid currentColor}.plan-toggle[aria-pressed="true"]:before{background:currentColor}.todo-panel{flex:none;width:min(812px,100%);margin:0 auto;padding:10px 32px 0}.todo-card{padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--surface)}.todo-head{display:flex;align-items:center;justify-content:space-between;gap:10px;color:var(--soft);font-size:11px}.todo-head strong{color:var(--muted);font-size:12px}.todo-list{display:flex;flex-direction:column;gap:4px;max-height:132px;margin:8px 0 0;padding:0;overflow:auto;list-style:none}.todo-item{display:flex;align-items:flex-start;gap:7px;color:var(--muted);font-size:12px;line-height:18px}.todo-item .todo-mark{flex:none;width:14px;color:var(--soft);text-align:center}.todo-item.in_progress{color:var(--ink)}.todo-item.in_progress .todo-mark{color:var(--accent)}.todo-item.completed{color:var(--soft);text-decoration:line-through}.todo-item.completed .todo-mark{color:var(--green);text-decoration:none}.plan-review pre{max-height:min(46vh,360px);margin:8px 0;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace}.plan-review textarea{display:block;width:100%;min-height:58px;max-height:130px;margin:0 0 10px;padding:8px 10px;border:1px solid var(--line);border-radius:6px;background:var(--input);color:var(--ink);font:12px/1.6 inherit;resize:vertical}.plan-review .approval-actions{gap:8px}.plan-review .approval-actions .primary:disabled,.plan-review .approval-actions .secondary:disabled{opacity:.55}
@media(max-width:767px){.todo-panel{padding:8px 16px 0}.plan-toggle{padding:0 6px}}
</style>
</head>
<body>
<svg class="icon-sprite" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <symbol id="icon-panel" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M13.5 1.5H2.5C1.94772 1.5 1.5 1.94772 1.5 2.5V13.5C1.5 14.0523 1.94772 14.5 2.5 14.5H13.5C14.0523 14.5 14.5 14.0523 14.5 13.5V2.5C14.5 1.94772 14.0523 1.5 13.5 1.5Z"/><path d="M5.5 1.5V14.5"/></symbol>
  <symbol id="icon-plus" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M8 2V14M2 8H14"/></symbol>
  <symbol id="icon-close" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M2.5 2.5L13.5 13.5M13.5 2.5L2.5 13.5"/></symbol>
  <symbol id="icon-search" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M6.58727 11.8586C9.55061 11.8586 11.9529 9.45637 11.9529 6.49304C11.9529 3.5297 9.55061 1.12744 6.58727 1.12744C3.62394 1.12744 1.22168 3.5297 1.22168 6.49304C1.22168 9.45637 3.62394 11.8586 6.58727 11.8586Z"/><path d="M10.2991 10.3933L14.7783 14.8725"/></symbol>
  <symbol id="icon-send" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M6.97211 1.94476C7.55785 1.35914 8.50767 1.35919 9.09343 1.94476L13.921 6.77228L13.2138 7.47939L8.38632 2.65187C8.19108 2.45682 7.87443 2.45677 7.67922 2.65187L2.74397 7.58711L2.03687 6.88L6.97211 1.94476Z" fill="currentColor" stroke="none"/><path d="M7.97571 14.5732L8.02421 2.34139"/></symbol>
  <symbol id="icon-stop" viewBox="0 0 16 16" fill="currentColor"><path d="M12.5 2.5H3.5C2.94772 2.5 2.5 2.94772 2.5 3.5V12.5C2.5 13.0523 2.94772 13.5 3.5 13.5H12.5C13.0523 13.5 13.5 13.0523 13.5 12.5V3.5C13.5 2.94772 13.0523 2.5 12.5 2.5Z"/></symbol>
  <symbol id="icon-theme" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M14.1127 8.70663C14.2576 8.60602 14.4627 8.71355 14.4386 8.88834C14.2901 9.96567 13.8731 10.9912 13.2229 11.8692C12.479 12.8735 11.4613 13.6421 10.2917 14.0829C9.1222 14.5236 7.85038 14.6179 6.62865 14.3543C5.40692 14.0907 4.28709 13.4805 3.40332 12.5967C2.51955 11.7129 1.90931 10.5931 1.64572 9.37135C1.38212 8.14962 1.47635 6.87779 1.91711 5.70825C2.35787 4.5387 3.12647 3.52103 4.13083 2.77714C5.00878 2.12689 6.03433 1.70994 7.11166 1.5614C7.28645 1.5373 7.39397 1.74238 7.29337 1.88734C6.68703 2.76099 6.37885 3.81241 6.42313 4.88345C6.47392 6.11194 6.98471 7.27645 7.85413 8.14587C8.72355 9.01529 9.88805 9.52608 11.1166 9.57687C12.1876 9.62114 13.239 9.31296 14.1127 8.70663Z"/></symbol>
  <symbol id="icon-more" viewBox="0 0 16 16" fill="currentColor"><path d="M3 9C3.55228 9 4 8.55228 4 8C4 7.44772 3.55228 7 3 7C2.44772 7 2 7.44772 2 8C2 8.55228 2.44772 9 3 9Z"/><path d="M8 9C8.55228 9 9 8.55228 9 8C9 7.44772 8.55228 7 8 7C7.44772 7 7 7.44772 7 8C7 8.55228 7.44772 9 8 9Z"/><path d="M13 9C13.5523 9 14 8.55228 14 8C14 7.44772 13.5523 7 13 7C12.4477 7 12 7.44772 12 8C12 8.55228 12.4477 9 13 9Z"/></symbol>
  <symbol id="icon-folder" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M1.50439 3.11059C1.50439 2.55831 1.95211 2.1106 2.50439 2.1106H5.43389C5.67773 2.1106 5.91318 2.19969 6.09593 2.36113L7.71649 3.79265C7.89924 3.95409 8.1347 4.04319 8.3785 4.04319H13.4958C14.0481 4.04319 14.4958 4.4909 14.4958 5.04319V12.8894C14.4958 13.4417 14.0481 13.8894 13.4958 13.8894H2.50439C1.95211 13.8894 1.50439 13.4417 1.50439 12.8894V4.04319V3.11059Z"/><path d="M3.63501 7.66614H12.3647"/></symbol>
  <symbol id="icon-permission-read-only" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1"><path d="M5.085 8.138 7.185 10.237 11.515 5.612"/><path d="M6.596 2.149a4 4 0 0 1 2.808 0l4.52 1.694v3.277c0 4.489-3.368 6.478-5.924 7.458-2.556-.98-5.925-2.969-5.925-7.458V3.843z" stroke-linejoin="round"/></symbol>
  <symbol id="icon-permission-workspace-write" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1"><path d="M6.596 2.149a4 4 0 0 1 2.808 0l4.52 1.694v3.277c0 4.489-3.368 6.478-5.924 7.458-2.556-.98-5.925-2.969-5.925-7.458V3.843z" stroke-linejoin="round"/><path d="M5.264 6.603h5.472M5.264 9.869h3.064M10 13l4-4"/></symbol>
  <symbol id="icon-permission-danger-full-access" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1"><path d="M6.596 2.149a4 4 0 0 1 2.808 0l4.52 1.694v3.277c0 4.489-3.368 6.478-5.924 7.458-2.556-.98-5.925-2.969-5.925-7.458V3.843z" stroke-linejoin="round"/><path d="M8 4.392v5.5m0 .916v1"/></symbol>
  <symbol id="icon-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="m4 6 4 4 4-4"/></symbol>
  <symbol id="icon-settings" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M8 9.75012C8.9665 9.75012 9.75 8.96662 9.75 8.00012C9.75 7.03362 8.9665 6.25012 8 6.25012C7.0335 6.25012 6.25 7.03362 6.25 8.00012C6.25 8.96662 7.0335 9.75012 8 9.75012Z"/><path d="M13.0107 7.79377C12.9505 7.89401 12.9205 7.94413 12.9205 7.99951C12.9205 8.0549 12.9505 8.10502 13.0106 8.20528L13.9849 9.83006C14.045 9.93029 14.0751 9.9804 14.0751 10.0358C14.0751 10.0911 14.045 10.1413 13.9849 10.2415L13.0037 11.8777C12.9468 11.9726 12.9184 12.0201 12.8725 12.0461C12.8267 12.072 12.7713 12.072 12.6607 12.072H10.6704C10.5598 12.072 10.5045 12.072 10.4586 12.098C10.4128 12.1239 10.3843 12.1714 10.3274 12.2662L9.33825 13.9142C9.28133 14.009 9.25287 14.0564 9.20703 14.0823C9.16118 14.1083 9.10588 14.1083 8.99529 14.1083H7.00486C6.89426 14.1083 6.83896 14.1083 6.79312 14.0823C6.74727 14.0564 6.71881 14.009 6.6619 13.9142L5.67273 12.2662C5.61581 12.1714 5.58735 12.1239 5.54151 12.098C5.49566 12.072 5.44036 12.072 5.32977 12.072H3.33945C3.2288 12.072 3.17347 12.072 3.12761 12.0461C3.08176 12.0201 3.0533 11.9726 2.9964 11.8777L2.0152 10.2415C1.9551 10.1413 1.92505 10.0911 1.92505 10.0358C1.92505 9.9804 1.9551 9.93029 2.0152 9.83006L2.98951 8.20528C3.04963 8.10502 3.07969 8.0549 3.07969 7.99951C3.07968 7.94413 3.04961 7.89401 2.98946 7.79377L2.01529 6.17011C1.95514 6.06987 1.92507 6.01975 1.92507 5.96437C1.92506 5.90899 1.95512 5.85886 2.01524 5.7586L2.9964 4.1224C3.0533 4.0275 3.08176 3.98005 3.12761 3.95408C3.17347 3.92811 3.2288 3.92811 3.33945 3.92811H5.32977C5.44036 3.92811 5.49566 3.92811 5.54151 3.90216C5.58735 3.87621 5.61581 3.82879 5.67273 3.73397L6.6619 2.08599C6.71881 1.99116 6.74727 1.94375 6.79312 1.9178C6.83896 1.89185 6.89426 1.89185 7.00486 1.89185H8.99529C9.10588 1.89185 9.16118 1.89185 9.20703 1.9178C9.25287 1.94375 9.28133 1.99116 9.33825 2.08599L10.3274 3.73397C10.3843 3.82879 10.4128 3.87621 10.4586 3.90216C10.5045 3.92811 10.5598 3.92811 10.6704 3.92811H12.6607C12.7713 3.92811 12.8267 3.92811 12.8725 3.95408C12.9184 3.98005 12.9468 4.0275 13.0037 4.1224L13.9849 5.7586C14.045 5.85886 14.0751 5.90899 14.0751 5.96437C14.0751 6.01975 14.045 6.06987 13.9849 6.17011L13.0107 7.79377Z"/></symbol>
</svg>
<div class="app" id="app">
  <button class="drawer-backdrop" id="drawer-backdrop" type="button" aria-label="Close navigation" hidden></button>
  <aside class="sidebar" id="sidebar" aria-label="Workspace navigation">
    <div class="brand-row"><div class="brand-mark" aria-hidden="true">◈</div><div class="brand-name">OmniAgent</div><button class="icon-button sidebar-toggle" id="sidebar-toggle" type="button" aria-label="Toggle navigation" title="Toggle navigation"><svg class="icon" aria-hidden="true"><use href="#icon-panel"/></svg></button></div>
    <div class="sidebar-body">
      <button class="new-session" id="new-session" type="button" aria-label="New session" title="New session"><svg class="icon" aria-hidden="true"><use href="#icon-plus"/></svg><span>New session</span></button>
      <section class="sessions-section" aria-labelledby="sessions-label"><div class="section-label"><span id="sessions-label">Workspaces</span><span><button class="icon-button" id="add-workspace" type="button" aria-label="Add workspace" title="Add workspace"><svg class="icon" aria-hidden="true"><use href="#icon-plus"/></svg></button><button class="icon-button" id="remove-workspace" type="button" aria-label="Unregister current workspace" title="Unregister current workspace"><svg class="icon" aria-hidden="true"><use href="#icon-close"/></svg></button></span></div><div class="search-wrap"><span class="search-icon" aria-hidden="true"><svg class="icon"><use href="#icon-search"/></svg></span><label class="sr-only" for="session-search">Search sessions</label><input class="search" id="session-search" type="search" placeholder="Search sessions" autocomplete="off" /></div><div class="workspace-tree" id="workspace-tree" aria-label="Workspace and session tree"></div><div class="session-list" id="session-list" aria-live="polite"></div><label class="sr-only" for="workspace-select">Active workspace</label><select class="sr-only" id="workspace-select" tabindex="-1"></select><span class="sr-only" id="workspace-path"></span></section>
    </div>
    <div class="sidebar-footer"><button class="settings-button" id="open-settings" type="button" aria-label="Open settings" title="Settings"><svg class="icon" aria-hidden="true"><use href="#icon-settings"/></svg><span>Settings</span></button><button class="icon-button theme-button" id="theme" type="button" aria-label="Switch color theme" title="Switch color theme"><svg class="icon" aria-hidden="true"><use href="#icon-theme"/></svg></button></div>
  </aside>
  <main class="main">
    <header class="topbar"><button class="icon-button drawer-button" id="drawer-toggle" type="button" aria-label="Open navigation" aria-controls="sidebar" aria-expanded="false" title="Open navigation"><svg class="icon" aria-hidden="true"><use href="#icon-panel"/></svg></button><div class="breadcrumbs"><span class="crumb-workspace" id="crumb-workspace">Workspace</span><span class="crumb-slash" aria-hidden="true">/</span><span class="crumb-session" id="crumb-session">No session selected</span></div><div class="status" id="status" role="status"><span class="status-dot"></span><span id="status-text">Ready</span></div></header>
    <nav class="tabs" role="tablist" aria-label="Session views"><button class="tab" id="tab-conversation" type="button" role="tab" aria-selected="true" aria-controls="conversation-view">Chat</button><button class="tab" id="tab-observe" type="button" role="tab" aria-selected="false" aria-controls="observe-view" tabindex="-1">Trajectory <span class="tab-count" id="event-count"></span></button><div class="session-menu"><button class="icon-button" id="session-actions" type="button" aria-label="Session actions" aria-haspopup="menu" aria-expanded="false" title="Session actions"><svg class="icon" aria-hidden="true"><use href="#icon-more"/></svg></button><div class="menu-surface" id="session-menu" role="menu" hidden><button id="copy-markdown" type="button" role="menuitem">Copy Session as Markdown</button><button id="download-json" type="button" role="menuitem" aria-describedby="export-disclosure">Download JSON transcript</button><p class="export-disclosure" id="export-disclosure">JSON is a transcript, not a DSH archive. Child sessions and attachment bytes are omitted. Content may include sensitive paths and tool output.</p></div></div></nav>
    <div class="alert" id="alert" role="alert" hidden><span id="alert-text"></span><button class="icon-button" id="dismiss-alert" type="button" aria-label="Dismiss error" title="Dismiss error"><svg class="icon" aria-hidden="true"><use href="#icon-close"/></svg></button></div>
    <section class="view conversation-view" id="conversation-view" role="tabpanel" aria-labelledby="tab-conversation"><section class="todo-panel" id="todo-panel" aria-label="Task list" hidden><div class="todo-card"><div class="todo-head"><strong>Tasks</strong><span id="todo-counts"></span></div><ol class="todo-list" id="todo-list"></ol></div></section><div class="transcript-scroll" id="transcript-scroll"><div class="transcript" id="transcript" aria-live="polite"></div></div></section><div class="approval-seat"><section class="approval" id="approval" aria-labelledby="approval-title" hidden><div class="approval-head"><strong id="approval-title">Approval required</strong><span id="approval-tool" class="mono"></span></div><p id="approval-reason"></p><div class="approval-label">Arguments</div><pre id="approval-arguments"></pre><div class="approval-actions"><button class="secondary" id="approval-reject" type="button">Reject</button><button class="primary" id="approval-allow" type="button">Allow once</button></div><div class="dialog-error" id="approval-error" role="alert" hidden></div></section><section class="approval plan-review" id="plan-review" aria-labelledby="plan-review-title" hidden><div class="approval-head"><strong id="plan-review-title">Review plan</strong><span>Plan mode</span></div><p>Approve the plan to leave plan mode and start implementing. Keep planning to send guidance back to the agent.</p><pre id="plan-review-content"></pre><label class="sr-only" for="plan-review-feedback">Guidance for continued planning</label><textarea id="plan-review-feedback" placeholder="Optional guidance if you keep planning…"></textarea><div class="approval-actions"><button class="secondary" id="plan-review-keep" type="button">Keep planning</button><button class="primary" id="plan-review-approve" type="button">Approve plan</button></div><div class="dialog-error" id="plan-review-error" role="alert" hidden></div></section></div><form class="composer-area" id="composer"><div class="composer-inner"><div class="composer-box"><label class="sr-only" for="prompt">Message</label><textarea id="prompt" rows="2" placeholder="Message the agent" disabled></textarea><div class="composer-actions"><div class="composer-meta"><button class="plan-toggle" id="plan-toggle" type="button" aria-label="Toggle plan mode" aria-pressed="false" title="Plan mode: investigate first, then submit a plan for review" disabled>Plan</button><div class="permission-picker"><button class="permission-entry" id="permission-entry" type="button" aria-label="Current session permission" aria-haspopup="menu" aria-expanded="false" aria-controls="permission-session-menu" disabled><svg class="icon" aria-hidden="true"><use id="permission-icon" href="#icon-permission-read-only"/></svg><span id="permission-current">Select permission</span><svg class="icon" aria-hidden="true"><use href="#icon-chevron"/></svg></button><div class="permission-menu session-permission-menu" id="permission-session-menu" role="menu" aria-label="Current session permission" hidden><button id="permission-session-read-only" type="button" role="menuitemradio" aria-checked="false" title="File writes are denied in the standing sandbox.">Read Only</button><button id="permission-session-workspace-write" type="button" role="menuitemradio" aria-checked="false" title="Write inside the workspace and permitted temporary directories; wider retries require approval.">Workspace Write</button><button id="permission-session-danger-full-access" type="button" role="menuitemradio" aria-checked="false" title="Full file access without approval prompts.">Full access</button></div><div class="agent-picker"><label class="sr-only" for="agent-select">Agent</label><select class="agent-select" id="agent-select" aria-label="Current session agent" disabled></select></div><div class="model-picker"><label class="sr-only" for="model-select">Model</label><select class="model-select" id="model-select" aria-label="Current session model" disabled></select></div></div><span id="composer-state">Select a session to begin</span></div><div class="controls"><button class="stop-button" id="stop" type="button" aria-label="Stop current turn" title="Stop current turn" hidden><svg class="icon" aria-hidden="true"><use href="#icon-stop"/></svg></button><button class="send-button" id="send" type="submit" aria-label="Send message" title="Send message" disabled><svg class="icon" aria-hidden="true"><use href="#icon-send"/></svg></button></div></div></div><div class="session-permission-error" id="session-permission-error" role="alert" hidden></div><div class="session-agent-error" id="session-agent-error" role="alert" hidden></div><div class="session-model-error" id="session-model-error" role="alert" hidden></div><div class="session-model-error" id="session-plan-error" role="alert" hidden></div><div class="composer-footer"><span class="composer-note" id="composer-note"></span></div></div></form>
    <section class="view observe-view" id="observe-view" role="tabpanel" aria-labelledby="tab-observe" hidden><div class="ledger"><div class="ledger-toolbar"><div class="ledger-title"><strong>Trajectory</strong><span id="ledger-count">No session selected</span></div><div class="trajectory-segments" role="group" aria-label="Trajectory display"><button id="trajectory-records" type="button" aria-pressed="true">Records</button><button id="trajectory-events" type="button" aria-pressed="false">Events</button></div><label class="sr-only" for="timeline-mode">Timeline scale</label><select class="filter-select" id="timeline-mode"><option value="sequence">Sequence</option><option value="time">Recorded time</option></select><label class="sr-only" for="event-filter">Filter records</label><select class="filter-select" id="event-filter"><option value="all">All records</option><option value="input">Input</option><option value="model">Model</option><option value="tools">Tools</option></select><label class="sr-only" for="trace-filter">Filter events</label><select class="filter-select" id="trace-filter" hidden><option value="all">All events</option><option value="lifecycle">Lifecycle</option><option value="tools">Tools</option><option value="errors">Errors</option><option value="audit">Audit</option></select><div class="search-wrap" id="record-search-wrap"><span class="search-icon" aria-hidden="true"><svg class="icon"><use href="#icon-search"/></svg></span><label class="sr-only" for="event-search">Search record metadata</label><input class="search ledger-search" id="event-search" type="search" placeholder="Search records" autocomplete="off" /></div><div class="search-wrap" id="trace-search-wrap" hidden><span class="search-icon" aria-hidden="true"><svg class="icon"><use href="#icon-search"/></svg></span><label class="sr-only" for="trace-search">Search event metadata</label><input class="search ledger-search" id="trace-search" type="search" placeholder="Search events" autocomplete="off" /></div></div><section class="timeline" aria-label="Trajectory timeline"><div class="timeline-labels" aria-hidden="true"><span>Input</span><span>Model</span><span>Tools</span></div><div class="timeline-track" id="timeline-track"></div></section><div class="table-scroll"><table class="event-table"><thead><tr><th scope="col">Kind</th><th scope="col">Seq</th><th scope="col" id="ledger-type-heading">Record</th><th scope="col">Recorded</th></tr></thead><tbody id="event-rows"></tbody></table><div class="ledger-empty" id="ledger-empty"></div></div></div><aside class="inspector" id="inspector" aria-label="Record inspector"><div class="inspector-header"><strong id="inspector-title">Record inspector</strong><span>Recorded metadata</span></div><div class="inspector-body" id="inspector-body"></div></aside></section>
  </main>
</div>
<dialog id="settings-dialog" class="settings-dialog" aria-labelledby="settings-title"><div class="settings-shell"><nav class="settings-nav" aria-label="Settings sections"><h2 id="settings-title">Settings</h2><button class="settings-nav-active" type="button" aria-current="page"><svg class="icon" aria-hidden="true"><use href="#icon-settings"/></svg>Permissions</button></nav><div class="settings-content"><div class="settings-head"><h2>Permissions</h2><button class="icon-button" id="close-settings" type="button" aria-label="Close settings" title="Close settings"><svg class="icon" aria-hidden="true"><use href="#icon-close"/></svg></button></div><div class="permission-settings"><div class="permission-row"><div class="permission-row-text"><div class="permission-row-title">Permission</div><div class="permission-row-description">Choose the default permission for new sessions. Existing sessions keep their current permission.</div></div><div class="permission-picker"><button class="permission-selector" id="permission-default-entry" type="button" aria-label="Default permission for new sessions" aria-haspopup="menu" aria-expanded="false" aria-controls="permission-default-menu" disabled><span id="permission-default-current">Loading</span><svg class="icon" aria-hidden="true"><use href="#icon-chevron"/></svg></button><div class="permission-menu" id="permission-default-menu" role="menu" aria-label="Default permission for new sessions" hidden><button id="permission-default-read-only" type="button" role="menuitemradio" aria-checked="false">Read Only</button><button id="permission-default-workspace-write" type="button" role="menuitemradio" aria-checked="false">Workspace Write</button><button id="permission-default-danger-full-access" type="button" role="menuitemradio" aria-checked="false">Full access</button></div></div></div><p class="permission-explanation">Read Only denies file writes in the standing sandbox. Workspace Write allows writes in the workspace and permitted temporary directories; wider retries require approval. Full access removes file sandbox restrictions and approval prompts. These presets do not isolate network access.</p><div class="dialog-error" id="permission-error" role="alert" hidden></div><div class="permission-status" id="permission-saved" role="status"></div></div></div></div></dialog>
<dialog id="permission-risk-dialog" aria-labelledby="permission-risk-title" aria-describedby="permission-risk-description"><div class="dialog-head"><h2 id="permission-risk-title">Enable Full access?</h2><button class="icon-button" id="permission-risk-close" type="button" aria-label="Close confirmation" title="Close"><svg class="icon" aria-hidden="true"><use href="#icon-close"/></svg></button></div><div class="dialog-body"><p id="permission-risk-description"></p><label class="risk-ack"><input id="permission-risk-ack" type="checkbox" /><span>I understand the risks and want to continue.</span></label></div><div class="dialog-actions"><button class="secondary" id="permission-risk-cancel" type="button">Cancel</button><button class="danger" id="permission-risk-confirm" type="button" disabled>Enable Full access</button></div></dialog>
<dialog id="workspace-dialog" aria-labelledby="workspace-dialog-title"><form id="workspace-form"><div class="dialog-head"><h2 id="workspace-dialog-title">Add workspace</h2><button class="icon-button" id="close-workspace-dialog" type="button" aria-label="Close dialog" title="Close dialog"><svg class="icon" aria-hidden="true"><use href="#icon-close"/></svg></button></div><div class="dialog-body"><label class="field" for="workspace-input">Directory path<input id="workspace-input" name="path" type="text" placeholder="/path/to/project" required autocomplete="off" /><span class="field-hint">An existing directory on this machine.</span></label><label class="field" for="workspace-name">Display name <span class="muted">(optional)</span><input id="workspace-name" name="name" type="text" autocomplete="off" /></label><div class="dialog-error" id="workspace-error" role="alert" hidden></div></div><div class="dialog-actions"><button class="secondary" id="cancel-workspace" type="button">Cancel</button><button class="primary" id="save-workspace" type="submit">Add workspace</button></div></form></dialog>
<dialog id="remove-dialog" aria-labelledby="remove-dialog-title"><div class="dialog-head"><h2 id="remove-dialog-title">Unregister workspace?</h2><button class="icon-button" id="close-remove-dialog" type="button" aria-label="Close dialog" title="Close dialog"><svg class="icon" aria-hidden="true"><use href="#icon-close"/></svg></button></div><div class="dialog-body"><p id="remove-description"></p><div class="dialog-error" id="remove-error" role="alert" hidden></div></div><div class="dialog-actions"><button class="secondary" id="cancel-remove" type="button">Cancel</button><button class="danger" id="confirm-remove" type="button">Unregister</button></div></dialog>
<script>
function sessionKey(workspaceId, sessionId) {
  return JSON.stringify([workspaceId, sessionId]);
}
function createSSEParser(onEvent) {
  let buffer = '';
  let data = [];
  function line(value) {
    if (value === '') {
      if (data.length) {
        const payload = data.join('\n');
        data = [];
        try { onEvent(JSON.parse(payload)); } catch (error) { throw new Error('Invalid event stream: ' + error.message); }
      }
      return;
    }
    if (value[0] === ':') return;
    const colon = value.indexOf(':');
    const field = colon < 0 ? value : value.slice(0, colon);
    let fieldValue = colon < 0 ? '' : value.slice(colon + 1);
    if (fieldValue[0] === ' ') fieldValue = fieldValue.slice(1);
    if (field === 'data') data.push(fieldValue);
  }
  function drain(final) {
    let index = 0;
    while (index < buffer.length) {
      let end = index;
      while (end < buffer.length && buffer[end] !== '\r' && buffer[end] !== '\n') end++;
      if (end === buffer.length) break;
      if (buffer[end] === '\r' && end + 1 === buffer.length && !final) break;
      line(buffer.slice(index, end));
      index = end + (buffer[end] === '\r' && buffer[end + 1] === '\n' ? 2 : 1);
    }
    buffer = buffer.slice(index);
    if (final) {
      if (buffer) line(buffer);
      buffer = '';
      line('');
    }
  }
  return { push(chunk) { buffer += chunk; drain(false); }, finish() { drain(true); } };
}
function messageText(message) {
  if (typeof message?.content === 'string') return message.content;
  if (!Array.isArray(message?.content)) return typeof message?.text === 'string' ? message.text : '';
  return message.content.map(part => part && part.type === 'text' && typeof part.text === 'string' ? part.text : '').join('');
}
function findTool(transcript, id) {
  if (!id) return undefined;
  for (let index = transcript.length - 1; index >= 0; index--) {
    const item = transcript[index];
    if (item.kind === 'tool' && (item.call?.id === id || item.result?.callId === id)) return item;
  }
}
function addToolCall(transcript, call, merge) {
  if (!call || typeof call !== 'object') return;
  let item = merge ? findTool(transcript, call.id) : undefined;
  if (item) item.call = Object.assign({}, item.call || {}, call);
  else transcript.push({ kind: 'tool', call: call });
}
function addToolResult(transcript, result) {
  if (!result || typeof result !== 'object') return;
  let item = findTool(transcript, result.callId);
  if (item) item.result = result;
  else transcript.push({ kind: 'tool', result: result });
}
function hydrateTranscript(messages, events) {
  const transcript = [];
  let source = Array.isArray(messages) ? messages : [];
  if (!source.length && Array.isArray(events)) {
    source = [];
    for (const event of events) {
      const data = event?.data || {};
      if (event?.type === 'message/user' || event?.type === 'user/message') source.push({ role: 'user', content: data.content || data.text || '' });
      else if (event?.type === 'message/assistant' || event?.type === 'assistant/message') source.push(data.message || data);
      else if (event?.type === 'message/tool-result' || event?.type === 'tool/result') source.push({ role: 'tool', results: [data.result || data] });
    }
  }
  for (const message of source) {
    if (!message || typeof message !== 'object') continue;
    if (message.role === 'user' || message.role === 'assistant' || message.role === 'system') {
      const text = messageText(message);
      if (text) transcript.push({ kind: message.role, text: text });
      if (message.role === 'assistant' && Array.isArray(message.toolCalls)) {
        for (const call of message.toolCalls) addToolCall(transcript, call, false);
      }
    } else if (message.role === 'tool' && Array.isArray(message.results)) {
      for (const result of message.results) addToolResult(transcript, result);
    }
  }
  return transcript;
}
function applyAgentEvent(turn, event) {
  if (!event || typeof event !== 'object') return;
  if (event.type === 'turn.start') turn.streamItem = null;
  else if (event.type === 'assistant.delta') {
    if (!turn.streamItem) {
      turn.streamItem = { kind: 'assistant', text: '' };
      turn.transcript.push(turn.streamItem);
    }
    turn.streamItem.text += typeof event.text === 'string' ? event.text : '';
  } else if (event.type === 'assistant.message') {
    const text = messageText(event.message);
    if (turn.streamItem) {
      turn.streamItem.text = text;
      if (!text) turn.transcript.splice(turn.transcript.indexOf(turn.streamItem), 1);
    } else if (text) turn.transcript.push({ kind: 'assistant', text: text });
    turn.streamItem = null;
    if (Array.isArray(event.message?.toolCalls)) for (const call of event.message.toolCalls) addToolCall(turn.transcript, call, false);
  } else if (event.type === 'tool.call') addToolCall(turn.transcript, event.call, true);
  else if (event.type === 'tool.result') addToolResult(turn.transcript, event.result);
  else if (event.type === 'permission.requested' && typeof event.requestId === 'string' && !turn.stopping && !turn.reason) {
    turn.approval = { requestId: event.requestId, call: event.call || {}, reason: typeof event.reason === 'string' ? event.reason : '', pending: false, error: '' };
  } else if (event.type === 'permission.decided' && turn.approval?.call?.id === event.callId) turn.approval = null;
  else if (event.type === 'plan.review.requested' && typeof event.requestId === 'string' && typeof event.plan === 'string' && !turn.stopping && !turn.reason) {
    turn.planReview = { requestId: event.requestId, plan: event.plan, pending: false, error: '', feedback: '' };
  } else if (event.type === 'plan.review.decided' && turn.planReview?.requestId === event.requestId) turn.planReview = null;
  else if (event.type === 'error') {
    turn.approval = null;
    turn.planReview = null;
    turn.error = typeof event.error?.message === 'string' ? event.error.message : 'The agent reported an error.';
    turn.transcript.push({ kind: 'notice', text: turn.error });
  } else if (event.type === 'turn.end') { turn.reason = event.reason; turn.approval = null; turn.planReview = null; }
}
function eventMetadata(event) {
  const metadata = {};
  const data = event && typeof event.data === 'object' && event.data !== null ? event.data : event || {};
  const type = typeof event?.type === 'string' ? event.type : 'event';
  const eventType = type.startsWith('trace/') ? type.slice(6) : type;
  function add(label, value) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') metadata[label] = value;
  }
  add('Type', type);
  add('Sequence', event?.seq);
  add('Timestamp', event?.ts);
  if (eventType === 'audit.tool') {
    add('Tool name', data.tool); add('Call ID', data.callId); add('Decision', data.decision);
    add('Success', data.ok); add('Duration (ms)', data.durationMs); add('Step', data.step);
  } else if (eventType === 'tool.call' || eventType === 'tool/call') {
    const call = data.call || data;
    add('Tool name', call.name); add('Call ID', call.id);
  } else if (eventType === 'tool.result' || eventType === 'tool/result' || eventType === 'message/tool-result') {
    const result = data.result || data;
    add('Tool name', result.name); add('Call ID', result.callId); add('Success', result.ok); add('Duration (ms)', result.durationMs); add('Truncated', result.truncated);
  } else if (eventType === 'permission.decided' || eventType === 'permission/decided') {
    add('Call ID', data.callId); add('Decision', data.decision);
  } else if (eventType === 'turn.start' || eventType === 'turn/start') add('Step', data.step);
  else if (eventType === 'turn.end' || eventType === 'turn/end') add('Reason', data.reason);
  else if (eventType === 'context.compacted' || eventType === 'context/compacted') {
    add('Before tokens', data.beforeTokens); add('After tokens', data.afterTokens);
  } else if (eventType === 'error') {
    add('Code', data.error?.code); add('Retryable', data.error?.retryable);
  }
  return metadata;
}
function safeEventMetadata(event) {
  const types = ['trace/turn.start', 'trace/turn.end', 'trace/tool.call', 'trace/permission.decided', 'trace/tool.result', 'trace/context.compacted', 'trace/error', 'audit.tool'];
  const type = types.includes(event?.type) ? event.type : 'trace/unknown';
  const raw = eventMetadata({ ...(event || {}), type: type });
  const metadata = { Type: type };
  const integer = value => Number.isSafeInteger(value) && value >= 0;
  const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const timestamp = value => integer(value) && value <= 8640000000000000;
  if (integer(raw.Sequence)) metadata.Sequence = raw.Sequence;
  if (type === 'audit.tool' && typeof raw.Timestamp === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(raw.Timestamp)) {
    const parsed = Date.parse(raw.Timestamp);
    if (timestamp(parsed) && new Date(parsed).toISOString() === (raw.Timestamp.length === 20 ? raw.Timestamp.slice(0, -1) + '.000Z' : raw.Timestamp)) metadata.Timestamp = parsed;
  } else if (type !== 'audit.tool' && timestamp(raw.Timestamp)) metadata.Timestamp = raw.Timestamp;
  if (['read_file', 'write_file', 'list_dir'].includes(raw['Tool name'])) metadata['Tool name'] = raw['Tool name'];
  if (['allow', 'ask', 'deny'].includes(raw.Decision)) metadata.Decision = raw.Decision;
  if (['end_turn', 'tool_use', 'max_tokens', 'max_steps', 'interrupted', 'error'].includes(raw.Reason)) metadata.Reason = raw.Reason;
  for (const label of ['Step', 'Before tokens', 'After tokens']) if (integer(raw[label])) metadata[label] = raw[label];
  if (nonnegative(raw['Duration (ms)'])) metadata['Duration (ms)'] = raw['Duration (ms)'];
  for (const label of ['Success', 'Truncated']) if (typeof raw[label] === 'boolean') metadata[label] = raw[label];
  return metadata;
}
function trajectoryModel(projection, scale) {
  const records = projection?.version === 1 && Array.isArray(projection.records) ? projection.records.filter(record => record && typeof record.id === 'string') : [];
  const byId = new Map(records.map(record => [record.id, record]));
  const raw = projection?.version === 1 && Array.isArray(projection.timeline?.[scale]) ? projection.timeline[scale] : [];
  const spans = raw.flatMap(span => {
    const record = byId.get(span?.recordId);
    if (!record || !['input', 'model', 'tools'].includes(span.lane) || !Number.isFinite(span.start) || !Number.isFinite(span.end) || span.end < span.start) return [];
    return [{ record: record, lane: span.lane, start: span.start, end: span.end }];
  });
  return { records: records, spans: spans };
}
/* WORKBENCH_UI */
const $ = id => document.getElementById(id);
const state = {
  workspaces: [], workspaceId: null, sessions: [], sessionId: null,
  selectedByWorkspace: {}, entries: new Map(), runs: new Map(), drafts: new Map(),
  workspacesLoading: true, sessionsLoading: false, workspaceError: '', sessionError: '',
  workspaceRequest: 0, sessionRequest: 0, selectionVersion: 0,
  creatingSession: false, tab: 'conversation', trajectoryView: 'records', selectedEvent: null, selectedTrace: null, alert: '', renderQueued: false,
  permissions: null, permissionsLoading: false, permissionsSaving: false, permissionsError: '', permissionRequest: 0, permissionConfirmation: null,
  models: [], modelsLoading: true, modelsError: '',
  agents: [], agentsLoading: true, agentsError: '', roles: [], rolesLoading: true, rolesError: '',
  creationAgent: 'default', creationBinding: { version: 2, kind: 'agent' },
};
function storageGet(key) { try { return localStorage.getItem(key); } catch (_) { return null; } }
function storageSet(key, value) { try { localStorage.setItem(key, value); } catch (_) {} }
function persistSelection() {
  storageSet('omniagent.activeWorkspace', state.workspaceId || '');
  storageSet('omniagent.activeSessions', JSON.stringify(state.selectedByWorkspace));
}
function workspaceById(id) { return state.workspaces.find(item => item.id === id); }
function currentEntry() { return state.workspaceId && state.sessionId ? state.entries.get(sessionKey(state.workspaceId, state.sessionId)) : null; }
function currentRun() { return state.workspaceId && state.sessionId ? state.runs.get(sessionKey(state.workspaceId, state.sessionId)) : null; }
function isCurrent(workspaceId, sessionId) { return state.workspaceId === workspaceId && state.sessionId === sessionId; }
function getEntry(workspaceId, sessionId) {
  const key = sessionKey(workspaceId, sessionId);
  let entry = state.entries.get(key);
  if (!entry) {
    entry = { header: null, permission: null, permissionSaving: false, permissionError: '', agent: null, agentSaving: false, agentError: '', agentWarnings: [], binding: null, resolvedModel: null, modelSaving: false, modelError: '', plan: null, planSaving: false, planError: '', todos: null, transcript: [], events: [], audit: [], trajectory: null, loaded: false, loading: false, error: '', request: 0, outcome: '' };
    state.entries.set(key, entry);
  }
  return entry;
}
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}
function apiPath(workspaceId, sessionId, suffix) {
  let path = '/api/workspaces/' + encodeURIComponent(workspaceId) + '/sessions';
  if (sessionId !== undefined) path += '/' + encodeURIComponent(sessionId);
  if (suffix) path += '/' + suffix;
  return path;
}
async function responseError(response) {
  try { const body = await response.json(); if (typeof body.error === 'string') return body.error; } catch (_) {}
  return 'Request failed (' + response.status + ').';
}
async function api(path, init) {
  const response = await fetch(path, init);
  if (!response.ok) throw new Error(await responseError(response));
  return response.json();
}
function jsonOptions(method, value) { return { method: method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }; }
function showError(message) { state.alert = message; renderAlert(); }
function renderAlert() { $('alert').hidden = !state.alert; $('alert-text').textContent = state.alert; }
function formatDate(value, withDate) {
  if (value === undefined || value === null || value === '') return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return withDate ? date.toLocaleString() : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function relativeDate(value) {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return 'Unknown time';
  const minutes = Math.max(0, Math.floor((Date.now() - time) / 60000));
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return minutes + 'm ago';
  if (minutes < 1440) return Math.floor(minutes / 60) + 'h ago';
  if (minutes < 10080) return Math.floor(minutes / 1440) + 'd ago';
  return new Date(time).toLocaleDateString();
}
function shortId(id) { const value = String(id || ''); return value.length > 20 ? value.slice(0, 16) + '…' : value; }
function normalizePlan(value) {
  return { active: !!value && typeof value.active === 'boolean' ? value.active : false };
}
function normalizeTodos(value) {
  if (!Array.isArray(value)) return null;
  const items = [];
  for (const item of value) {
    if (!item || typeof item.content !== 'string' || !['pending', 'in_progress', 'completed'].includes(item.status)) return null;
    items.push({ content: item.content, status: item.status });
  }
  return items;
}
function renderSidebar() {
  const select = $('workspace-select');
  select.replaceChildren();
  if (!state.workspaces.length) {
    const option = element('option', '', state.workspacesLoading ? 'Loading workspaces…' : 'Select workspace');
    option.value = ''; select.append(option);
  }
  for (const workspace of state.workspaces) {
    const option = element('option', '', workspace.name || workspace.path || workspace.id);
    option.value = workspace.id; select.append(option);
  }
  select.value = state.workspaceId || '';
  select.disabled = state.workspacesLoading || !state.workspaces.length;
  $('remove-workspace').disabled = !state.workspaceId;
  $('new-session').disabled = !state.workspaceId || state.sessionsLoading || state.creatingSession;
  $('session-search').disabled = !state.workspaceId;
  const workspace = workspaceById(state.workspaceId);
  $('workspace-path').textContent = workspace?.path || (state.workspaceError ? 'Workspaces unavailable' : 'No workspace selected');
  $('workspace-path').title = workspace?.path || '';
  const list = $('session-list'); const tree = $('workspace-tree'); tree.replaceChildren();
  for (const workspace of state.workspaces) {
    const row = element('button', 'workspace-row' + (workspace.id === state.workspaceId ? ' active' : ''));
    row.type = 'button'; row.setAttribute('aria-expanded', String(workspace.id === state.workspaceId));
    row.title = workspace.path || workspace.name || workspace.id;
    const caret = element('span', 'workspace-caret', workspace.id === state.workspaceId ? '▾' : '▸'); caret.setAttribute('aria-hidden', 'true');
    const folder = element('span', 'workspace-folder', '▣'); folder.setAttribute('aria-hidden', 'true');
    row.append(caret, folder, element('span', 'workspace-name', workspace.name || workspace.path || workspace.id));
    row.addEventListener('click', () => { if (workspace.id !== state.workspaceId) selectWorkspace(workspace.id); });
    tree.append(row);
    if (workspace.id === state.workspaceId) tree.append(list);
  }
  list.replaceChildren();
  if (!state.workspaceId) tree.append(list);
  if (state.workspacesLoading || state.sessionsLoading) { list.append(element('div', 'side-empty', 'Loading sessions…')); return; }
  if (state.workspaceError) { list.append(element('div', 'side-empty', state.workspaceError)); return; }
  if (state.sessionError) { list.append(element('div', 'side-empty', state.sessionError)); return; }
  if (!state.workspaceId) { list.append(element('div', 'side-empty', 'Add a workspace to get started.')); return; }
  const query = $('session-search').value.trim().toLowerCase();
  const filtered = state.sessions.filter(item => [item.id, item.agent, item.agentId, item.cwd, item.description, item.parentSessionId].some(value => String(value || '').toLowerCase().includes(query)));
  if (!filtered.length) { list.append(element('div', 'side-empty', query ? 'No matching sessions.' : 'No sessions yet.')); return; }
  for (const item of filtered) {
    const button = element('button', 'session-button' + (item.id === state.sessionId ? ' active' : ''));
    button.type = 'button'; button.setAttribute('aria-current', item.id === state.sessionId ? 'true' : 'false');
    const child = typeof item.parentSessionId === 'string' && item.parentSessionId.length > 0;
    button.title = child ? String(item.description || item.id) + '\nSubagent · depth ' + (item.depth ?? 1) : String(item.id);
    const glyph = element('span', 'session-glyph', child ? '↳' : '▤'); glyph.setAttribute('aria-hidden', 'true');
    const content = element('span');
    const name = child && typeof item.description === 'string' && item.description.trim()
      ? item.description.trim()
      : 'Session ' + shortId(item.id);
    content.append(element('span', 'session-name', name));
    const count = typeof item.eventCount === 'number' ? item.eventCount + (item.eventCount === 1 ? ' event' : ' events') : '';
    const relation = child ? 'subagent · depth ' + (item.depth ?? 1) : '';
    const agent = typeof item.agent === 'string' && item.agent ? 'agent ' + item.agent : '';
    content.append(element('span', 'session-meta', [relativeDate(item.updatedAt || item.createdAt), agent, relation, count].filter(Boolean).join(' · ')));
    button.append(glyph, content);
    button.addEventListener('click', () => { selectSession(item.id); closeDrawer(); });
    list.append(button);
  }
}
function renderHeader() {
  const workspace = workspaceById(state.workspaceId);
  const entry = currentEntry();
  const description = typeof entry?.header?.description === 'string' ? entry.header.description.trim() : '';
  $('crumb-workspace').textContent = workspace?.name || workspace?.path || 'Workspace';
  $('crumb-workspace').title = workspace?.path || '';
  $('crumb-session').textContent = state.sessionId
    ? (description ? 'Subagent · ' + description : entry?.agent ? entry.agent.name + ' · Session ' + shortId(state.sessionId) : 'Session ' + shortId(state.sessionId))
    : 'No session selected';
  $('crumb-session').title = state.sessionId || '';
  $('session-actions').disabled = !state.workspaceId || !state.sessionId;
  const run = currentRun();
  const status = $('status'); status.className = 'status';
  let label = 'Ready';
  if (run) { status.classList.add('running'); label = run.stopping ? 'Stopping' : run.finishing ? 'Finishing' : run.planReview ? 'Waiting for plan review' : run.approval ? 'Waiting for approval' : 'Running'; }
  else if (entry?.error || entry?.outcome === 'error') { status.classList.add('error'); label = 'Error'; }
  else if (entry?.outcome === 'interrupted') { status.classList.add('interrupted'); label = 'Interrupted'; }
  else if (entry?.loading || state.sessionsLoading || state.workspacesLoading) label = 'Loading';
  else if (entry?.plan?.active) label = 'Plan mode';
  $('status-text').textContent = label; status.title = label;
}
function emptyState(container, symbol, heading, description, action, actionText) {
  const blank = element('div', 'empty-state');
  const icon = element('div', 'empty-icon', symbol); icon.setAttribute('aria-hidden', 'true');
  blank.append(icon, element('strong', '', heading), element('p', '', description));
  if (action) { const button = element('button', 'secondary', actionText); button.type = 'button'; button.addEventListener('click', action); blank.append(button); }
  container.append(blank);
}
function renderTranscript(forceBottom) {
  const scroll = $('transcript-scroll');
  const nearBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 100;
  const openTools = new Set(Array.from($('transcript').querySelectorAll('details[open]')).map(node => node.dataset.toolKey));
  const container = $('transcript'); container.replaceChildren();
  const entry = currentEntry();
  if (state.workspacesLoading || state.sessionsLoading || entry?.loading && !entry.loaded) { emptyState(container, '◌', 'Loading session', 'Retrieving workspace history.'); return; }
  if (state.workspaceError) { emptyState(container, '!', 'Workspaces unavailable', state.workspaceError, loadWorkspaces, 'Retry'); return; }
  if (state.sessionError) { emptyState(container, '!', 'Sessions unavailable', state.sessionError, () => loadSessions(state.workspaceId, true), 'Retry'); return; }
  if (!state.workspaceId) { emptyState(container, '◈', 'No workspace selected', 'Add a local directory to start a session.', openWorkspaceDialog, 'Add workspace'); return; }
  if (!state.sessionId) { emptyState(container, '▤', 'Start a session', 'Create a session in this workspace to begin.', createSession, 'New session'); return; }
  if (entry?.error && !entry.loaded) { emptyState(container, '!', 'Session unavailable', entry.error, () => loadDetail(state.workspaceId, state.sessionId), 'Retry'); return; }
  if (!entry || !entry.transcript.length) { emptyState(container, '◇', 'Ready when you are', 'Send a message to begin this session.'); return; }
  const heading = element('div', 'conversation-heading', 'Session transcript'); container.append(heading);
  let toolIndex = 0;
  for (const item of entry.transcript) {
    if (item.kind === 'tool') {
      const key = String(item.call?.id || item.result?.callId || '') + ':' + toolIndex++;
      const details = element('details', 'tool-row'); details.dataset.toolKey = key; details.open = openTools.has(key);
      const summary = element('summary');
      const name = item.call?.name || item.result?.name || 'Tool';
      summary.append(element('span', 'tool-name', name), element('span', 'tool-label', 'tool call'));
      const result = item.result;
      const toolStatus = element('span', 'tool-status' + (result ? result.ok ? ' ok' : ' failed' : ''), result ? result.ok ? 'Completed' : 'Failed' : 'Pending');
      summary.append(toolStatus); details.append(summary);
      const info = element('div', 'tool-details');
      if (item.call && item.call.arguments !== undefined) { info.append(element('h4', '', 'Arguments'), element('pre', '', stringify(item.call.arguments))); }
      if (result && typeof result.content === 'string') { info.append(element('h4', '', 'Result'), element('pre', '', result.content)); }
      if (!info.childNodes.length) info.append(element('span', '', 'No details available.'));
      details.append(info); container.append(details); continue;
    }
    const article = element('article', 'message ' + (['assistant', 'user', 'system', 'notice'].includes(item.kind) ? item.kind : 'notice'));
    const avatar = element('div', 'avatar', item.kind === 'user' ? 'U' : item.kind === 'assistant' ? '◈' : '!'); avatar.setAttribute('aria-hidden', 'true');
    const content = element('div', 'message-content');
    content.append(element('div', 'message-label', item.kind === 'user' ? 'You' : item.kind === 'assistant' ? 'OmniAgent' : item.kind === 'system' ? 'System' : 'Notice'), element('div', 'message-body', item.text || ''));
    article.append(avatar, content); container.append(article);
  }
  if (forceBottom || nearBottom) scroll.scrollTop = scroll.scrollHeight;
}
function stringify(value) { try { const result = JSON.stringify(value, null, 2); return result === undefined ? String(value) : result; } catch (_) { return '[Unable to display value]'; } }
function renderComposer() {
  const entry = currentEntry(); const run = currentRun(); const available = !!state.workspaceId && !!state.sessionId && !!entry?.loaded && !entry.loading;
  const creating = !!state.workspaceId && !state.sessionId && !state.creatingSession;
  const preset = entry?.permission?.preset; const selected = isPermissionPreset(preset);
  const saving = !!entry?.permissionSaving || !!entry?.agentSaving || !!entry?.modelSaving || !!entry?.planSaving;
  const locked = !available || !!run || saving;
  const pickerLocked = (!available && !creating) || !!run || saving;
  $('prompt').disabled = !available;
  $('send').disabled = locked || !selected || !entry?.agent || !entry?.binding || !$('prompt').value.trim();
  $('stop').hidden = !run; $('stop').disabled = !!run?.stopping || !!run?.finishing;
  $('composer-state').textContent = !state.workspaceId ? 'Select a workspace' : creating ? 'Choose an agent and model, then create a session' : !state.sessionId ? 'Select a session to begin' : !entry?.loaded ? 'Loading session' : run ? run.stopping ? 'Stopping…' : run.finishing ? 'Saving session…' : run.planReview ? 'Waiting for plan review' : run.approval ? 'Waiting for approval' : 'Agent is working' : entry.permissionSaving ? 'Saving permission…' : entry.agentSaving ? 'Saving agent…' : entry.modelSaving ? 'Saving model…' : entry.planSaving ? 'Saving plan mode…' : !entry.agent ? 'Select an agent before sending' : !entry.binding ? 'Select a model source before sending' : !selected ? 'Choose permission before sending' : 'Ready to send';
  $('permission-current').textContent = !available ? 'Select permission' : selected ? permissionPresets[preset].label : 'Select permission';
  $('permission-icon').setAttribute('href', '#icon-permission-' + (selected ? preset : 'read-only'));
  $('permission-entry').disabled = locked;
  $('permission-entry').title = run ? 'Permission cannot be changed during a turn.' : selected ? permissionPresets[preset].description : 'Choose a permission for this session.';
  $('permission-entry').setAttribute('aria-label', 'Current session permission: ' + $('permission-current').textContent);
  for (const id of Object.keys(permissionPresets)) $('permission-session-' + id).setAttribute('aria-checked', String(preset === id));
  if (locked) closePermissionMenu('session');
  $('session-permission-error').textContent = entry?.permissionError || '';
  $('session-permission-error').hidden = !entry?.permissionError;
  const planActive = !!entry?.plan?.active;
  $('plan-toggle').disabled = locked;
  $('plan-toggle').setAttribute('aria-pressed', String(planActive));
  $('plan-toggle').textContent = planActive ? 'Planning' : 'Plan';
  $('plan-toggle').title = run ? 'Plan mode cannot be changed during a turn.' : planActive ? 'Plan mode is on: the agent researches and submits a plan before editing.' : 'Turn on plan mode: research first, then submit a plan for approval.';
  $('session-plan-error').textContent = entry?.planError || '';
  $('session-plan-error').hidden = !entry?.planError;
  renderAgentPicker(entry, pickerLocked, creating);
  renderModelPicker(entry, pickerLocked, creating);
  const agentError = entry?.agentError || '';
  $('session-agent-error').textContent = agentError;
  $('session-agent-error').hidden = !agentError;
  $('session-model-error').textContent = entry?.modelError || '';
  $('session-model-error').hidden = !entry?.modelError;
  renderTodos();
  renderApproval();
  renderPlanReview();
  $('composer-note').textContent = entry?.header?.cwd || workspaceById(state.workspaceId)?.path || '';
  $('composer-note').title = $('composer-note').textContent;
}
function ledgerEvents(entry) {
  if (!entry) return [];
  const traces = Array.isArray(entry.events) ? entry.events : [];
  const audit = Array.isArray(entry.audit) ? entry.audit : [];
  return traces.flatMap((event, index) => event && typeof event.type === 'string' && event.type.startsWith('trace/') ? [{ id: 'trace:' + index, metadata: safeEventMetadata(event) }] : [])
    .concat(audit.map((item, index) => ({ id: 'audit:' + index, metadata: safeEventMetadata({ type: 'audit.tool', ts: item?.ts, data: item }) })));
}
function eventCategory(metadata) {
  const type = metadata.Type;
  if (type === 'audit.tool') return 'audit';
  if (type === 'trace/error') return 'errors';
  if (type === 'trace/tool.call' || type === 'trace/tool.result' || type === 'trace/permission.decided') return 'tools';
  return 'lifecycle';
}
function eventSummary(metadata) {
  const parts = [];
  if (metadata['Tool name'] !== undefined) parts.push(metadata['Tool name']);
  if (metadata.Decision !== undefined) parts.push(metadata.Decision);
  if (metadata.Success !== undefined) parts.push(metadata.Success ? 'succeeded' : 'failed');
  if (metadata.Reason !== undefined) parts.push(metadata.Reason);
  if (metadata.Step !== undefined) parts.push('step ' + metadata.Step);
  if (metadata['Duration (ms)'] !== undefined) parts.push(metadata['Duration (ms)'] + ' ms');
  if (metadata['Before tokens'] !== undefined && metadata['After tokens'] !== undefined) parts.push(metadata['Before tokens'] + ' → ' + metadata['After tokens'] + ' tokens');
  return parts.join(' · ');
}
function recordMetadata(record) {
  const labels = { id: 'Record ID', kind: 'Kind', seq: 'Sequence', turnId: 'Turn ID', stepId: 'Step ID', step: 'Step', timestamp: 'Timestamp', assistantSeq: 'Assistant sequence', assistantRecordedAt: 'Assistant recorded at', inputTokens: 'Input tokens', outputTokens: 'Output tokens', name: 'Tool name', callSeq: 'Call sequence', callRecordedAt: 'Call recorded at', resultSeq: 'Result sequence', resultRecordedAt: 'Result recorded at', durationMs: 'Duration (ms)', ok: 'Success', truncated: 'Truncated', decision: 'Decision' };
  const metadata = {};
  for (const [key, label] of Object.entries(labels)) if (record[key] !== undefined && record[key] !== null && ['string', 'number', 'boolean'].includes(typeof record[key])) metadata[label] = record[key];
  return metadata;
}
function recordLabel(record) {
  if (record.kind === 'input') return 'User input';
  if (record.kind === 'model') return 'Model response';
  if (record.kind === 'tool') return record.name || 'Tool';
  return 'Record';
}
function renderObserve() {
  const entry = currentEntry(); const scale = $('timeline-mode').value === 'time' ? 'time' : 'sequence';
  const model = trajectoryModel(entry?.trajectory, scale); const records = model.records;
  const eventsView = state.trajectoryView === 'events';
  const events = eventsView ? ledgerEvents(entry) : [];
  const filter = $(eventsView ? 'trace-filter' : 'event-filter').value || 'all';
  const query = $(eventsView ? 'trace-search' : 'event-search').value.trim().toLowerCase();
  const visibleRecords = records.filter(record => (eventsView || filter === 'all' || (record.kind === 'tool' ? 'tools' : record.kind) === filter) && (eventsView || !query || Object.values(recordMetadata(record)).join(' ').toLowerCase().includes(query)));
  const visibleEvents = events.filter(item => (filter === 'all' || eventCategory(item.metadata) === filter) && (!query || (Object.values(item.metadata).join(' ') + ' ' + eventSummary(item.metadata) + ' ' + eventCategory(item.metadata)).toLowerCase().includes(query)));
  const visibleCount = eventsView ? visibleEvents.length : visibleRecords.length;
  const totalCount = eventsView ? events.length : records.length;
  const unit = eventsView ? 'event' : 'record';
  $('event-count').textContent = entry?.trajectory ? String(records.length) : '';
  $('ledger-count').textContent = !state.sessionId ? 'No session selected' : visibleCount + ' of ' + totalCount + ' ' + unit + (totalCount === 1 ? '' : 's');
  $('trajectory-records').setAttribute('aria-pressed', String(!eventsView)); $('trajectory-events').setAttribute('aria-pressed', String(eventsView));
  $('event-filter').hidden = eventsView; $('trace-filter').hidden = !eventsView;
  $('record-search-wrap').hidden = eventsView; $('trace-search-wrap').hidden = !eventsView;
  $('ledger-type-heading').textContent = eventsView ? 'Event' : 'Record';
  $('inspector-title').textContent = eventsView ? 'Event inspector' : 'Record inspector';
  $('inspector').setAttribute('aria-label', eventsView ? 'Event inspector' : 'Record inspector');
  const selectRecord = (id, rowIndex) => {
    if (state.trajectoryView === 'events') {
      const record = records.find(item => item.id === id); const recordFilter = $('event-filter').value || 'all'; const recordQuery = $('event-search').value.trim().toLowerCase();
      if (record && ((recordFilter !== 'all' && (record.kind === 'tool' ? 'tools' : record.kind) !== recordFilter) || (recordQuery && !Object.values(recordMetadata(record)).join(' ').toLowerCase().includes(recordQuery)))) { $('event-filter').value = 'all'; $('event-search').value = ''; }
    }
    state.selectedEvent = id; state.trajectoryView = 'records'; renderObserve(); if (rowIndex !== undefined) { const row = $('event-rows').childNodes[rowIndex]; if (row) row.focus({ preventScroll: true }); }
  };
  const selectTrace = (id, rowIndex) => { state.selectedTrace = id; renderObserve(); const row = $('event-rows').childNodes[rowIndex]; if (row) row.focus({ preventScroll: true }); };
  const track = $('timeline-track'); track.replaceChildren();
  const visibleIds = new Set(visibleRecords.map(record => record.id));
  if (model.spans.length) {
    const start = Math.min(...model.spans.map(span => span.start)); const end = Math.max(...model.spans.map(span => span.end)); const width = Math.max(1, end - start);
    for (const span of model.spans) {
      if (!visibleIds.has(span.record.id)) continue;
      const marker = element('button', 'timeline-span ' + span.lane + (!eventsView && state.selectedEvent === span.record.id ? ' selected' : ''));
      marker.type = 'button'; marker.style.left = ((span.start - start) / width * 100) + '%'; marker.style.width = ((span.end - span.start) / width * 100) + '%';
      marker.setAttribute('aria-label', 'Inspect ' + recordLabel(span.record) + ', sequence ' + span.record.seq); marker.title = recordLabel(span.record);
      marker.addEventListener('click', () => selectRecord(span.record.id)); track.append(marker);
    }
  } else track.append(element('span', 'timeline-empty', scale === 'time' ? 'No recorded timing' : 'No records'));
  const rows = $('event-rows'); rows.replaceChildren();
  if (eventsView) {
    for (const [index, item] of visibleEvents.entries()) {
      const metadata = item.metadata; const category = eventCategory(metadata);
      const kind = { audit: 'Audit', errors: 'Error', tools: 'Tool', lifecycle: 'Lifecycle' }[category];
      const row = element('tr'); row.tabIndex = 0; row.setAttribute('aria-selected', String(state.selectedTrace === item.id)); row.setAttribute('aria-label', 'Inspect ' + metadata.Type);
      const description = element('td', 'event-type', metadata.Type); const summary = eventSummary(metadata);
      if (summary) description.append(element('div', 'event-info', summary));
      row.append(element('td', 'event-kind ' + category, kind), element('td', 'mono muted', metadata.Sequence ?? '—'), description, element('td', 'mono muted', formatDate(metadata.Timestamp, false)));
      row.addEventListener('click', () => selectTrace(item.id, index)); row.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectTrace(item.id, index); } }); rows.append(row);
    }
  } else {
    for (const [index, record] of visibleRecords.entries()) {
      const row = element('tr'); row.tabIndex = 0; row.setAttribute('aria-selected', String(state.selectedEvent === record.id)); row.setAttribute('aria-label', 'Inspect ' + recordLabel(record));
      row.append(element('td', 'event-kind ' + record.kind, record.kind === 'tool' ? 'Tool' : record.kind === 'model' ? 'Model' : 'Input'), element('td', 'mono muted', record.seq ?? '—'), element('td', 'event-type', recordLabel(record)), element('td', 'mono muted', formatDate(record.timestamp, false)));
      row.addEventListener('click', () => selectRecord(record.id, index)); row.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectRecord(record.id, index); } }); rows.append(row);
    }
  }
  const empty = $('ledger-empty'); empty.hidden = visibleCount > 0;
  empty.textContent = !state.sessionId ? 'Select a session to inspect its trajectory.' : eventsView ? !events.length ? 'No events in this session.' : 'No events match these filters.' : !entry?.trajectory ? 'Trajectory is not available for this session.' : !records.length ? 'No records in this session.' : 'No records match these filters.';
  const inspector = $('inspector-body'); inspector.replaceChildren();
  const selected = eventsView ? events.find(item => item.id === state.selectedTrace) : records.find(record => record.id === state.selectedEvent);
  if (!selected) { inspector.append(element('div', 'inspector-placeholder', 'Select ' + (eventsView ? 'an event' : 'a record') + ' to inspect its metadata.')); return; }
  const metadata = eventsView ? selected.metadata : recordMetadata(selected);
  inspector.append(element('div', 'inspector-type', eventsView ? metadata.Type : recordLabel(selected)), element('div', 'inspector-caption', 'Recorded metadata'));
  const list = element('dl'); list.style.margin = '0';
  for (const [label, value] of Object.entries(metadata)) {
    const row = element('div', 'metadata-row'); row.append(element('dt', '', label), element('dd', '', label === 'Timestamp' || label.endsWith('recorded at') ? formatDate(value, true) : String(value))); list.append(row);
  }
  inspector.append(list);
}
function renderAll(forceBottom) { renderAlert(); renderSidebar(); renderHeader(); renderTranscript(forceBottom); renderComposer(); renderObserve(); }
function queueRender() {
  if (state.renderQueued) return;
  state.renderQueued = true;
  requestAnimationFrame(() => { state.renderQueued = false; renderHeader(); renderTranscript(false); renderComposer(); renderObserve(); });
}
function setTab(tab) {
  state.tab = tab;
  for (const name of ['conversation', 'observe']) {
    const selected = name === tab; const button = $('tab-' + name);
    button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1;
    $(name + '-view').hidden = !selected;
  }
  if (tab === 'observe') renderObserve();
}
function closeDrawer() {
  const wasOpen = $('app').classList.contains('drawer-open');
  $('app').classList.remove('drawer-open'); $('drawer-backdrop').hidden = true;
  $('drawer-toggle').setAttribute('aria-expanded', 'false');
  if (wasOpen) $('drawer-toggle').focus();
}
function openDrawer() {
  $('drawer-backdrop').hidden = false; $('app').classList.add('drawer-open');
  $('drawer-toggle').setAttribute('aria-expanded', 'true'); $('add-workspace').focus();
}
async function loadWorkspaces(preferredId) {
  const request = ++state.workspaceRequest; state.workspacesLoading = true; state.workspaceError = ''; renderAll();
  try {
    const body = await api('/api/workspaces');
    if (request !== state.workspaceRequest) return;
    state.workspaces = Array.isArray(body.workspaces) ? body.workspaces : [];
    const preferred = preferredId || state.workspaceId || storageGet('omniagent.activeWorkspace');
    const next = state.workspaces.find(item => item.id === preferred) || state.workspaces[0];
    state.workspacesLoading = false;
    if (next && (state.workspaceId !== next.id || !state.sessions.length)) await selectWorkspace(next.id);
    else if (!next) { state.workspaceId = null; state.sessionId = null; state.sessions = []; persistSelection(); }
  } catch (error) {
    if (request !== state.workspaceRequest) return;
    state.workspacesLoading = false; state.workspaceError = error.message; showError('Could not load workspaces: ' + error.message);
  } finally { if (request === state.workspaceRequest) renderAll(); }
}
async function selectWorkspace(id) {
  if (!id || !workspaceById(id)) return;
  closePermissionMenu('session'); closePermissionConfirmation('session');
  state.selectionVersion++; state.sessionRequest++;
  state.workspaceId = id; state.sessionId = null; state.sessions = []; state.sessionError = ''; state.selectedEvent = null; state.selectedTrace = null;
  $('session-search').value = ''; $('prompt').value = ''; state.alert = ''; persistSelection(); renderAll();
  await loadSessions(id, true);
}
async function loadSessions(workspaceId, restore) {
  if (!workspaceId) return;
  const request = ++state.sessionRequest; state.sessionsLoading = true; state.sessionError = ''; renderAll();
  try {
    const body = await api(apiPath(workspaceId));
    if (request !== state.sessionRequest || state.workspaceId !== workspaceId) return;
    state.sessions = (Array.isArray(body.sessions) ? body.sessions : []).slice().sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
    state.sessionsLoading = false;
    if (restore) {
      const wanted = state.selectedByWorkspace[workspaceId];
      const found = state.sessions.find(item => item.id === wanted) || state.sessions[0];
      if (found) selectSession(found.id);
      else { state.sessionId = null; delete state.selectedByWorkspace[workspaceId]; persistSelection(); }
    }
  } catch (error) {
    if (request !== state.sessionRequest || state.workspaceId !== workspaceId) return;
    state.sessionsLoading = false; state.sessionError = error.message; showError('Could not load sessions: ' + error.message);
  } finally { if (request === state.sessionRequest && state.workspaceId === workspaceId) renderAll(); }
}
function selectSession(id) {
  if (!state.workspaceId || !id) return;
  closePermissionMenu('session'); closePermissionConfirmation('session');
  state.selectionVersion++; state.sessionId = id; state.selectedByWorkspace[state.workspaceId] = id; state.selectedEvent = null; state.selectedTrace = null; state.alert = '';
  persistSelection();
  const key = sessionKey(state.workspaceId, id); $('prompt').value = state.drafts.get(key) || '';
  const entry = getEntry(state.workspaceId, id);
  renderAll(true);
  if (!state.runs.has(key)) loadDetail(state.workspaceId, id);
  else if (!entry.loaded) entry.loading = false;
}
async function loadDetail(workspaceId, sessionId, reconcile) {
  if (!workspaceId || !sessionId) return false;
  const key = sessionKey(workspaceId, sessionId); const entry = getEntry(workspaceId, sessionId);
  if (state.runs.has(key) && !reconcile || entry.permissionSaving || entry.agentSaving || entry.modelSaving) return false;
  const request = ++entry.request; entry.loading = true; entry.error = '';
  if (isCurrent(workspaceId, sessionId)) renderAll();
  try {
    const body = await api(apiPath(workspaceId, sessionId));
    if (entry.request !== request || state.entries.get(key) !== entry || state.runs.has(key) && !reconcile) return false;
    if (!body.permission || !Object.hasOwn(body.permission, 'preset') || body.permission.preset !== null && !isPermissionPreset(body.permission.preset)) throw new Error('Invalid session permission response.');
    entry.header = body.header || null;
    entry.permission = { preset: body.permission.preset }; entry.permissionError = '';
    entry.agent = validateAgentSummary(body.agent); entry.agentError = typeof body.agentError === 'string' ? body.agentError : '';
    entry.agentWarnings = Array.isArray(body.agentWarnings) ? body.agentWarnings.filter(item => typeof item === 'string') : [];
    entry.binding = validateModelBinding(body.model); entry.resolvedModel = validateResolvedModel(body.resolvedModel); entry.modelError = '';
    entry.plan = normalizePlan(body.plan); entry.planError = '';
    entry.todos = normalizeTodos(body.todos);
    entry.events = Array.isArray(body.events) ? body.events : [];
    entry.audit = Array.isArray(body.audit) ? body.audit : [];
    entry.trajectory = body.trajectory || null;
    entry.transcript = hydrateTranscript(Array.isArray(body.messages) ? body.messages : [], entry.events);
    entry.loaded = true; entry.error = '';
    if (isCurrent(workspaceId, sessionId)) { state.selectedEvent = null; state.selectedTrace = null; }
    return true;
  } catch (error) {
    if (entry.request !== request || state.entries.get(key) !== entry) return false;
    entry.error = error.message;
    entry.permission = null;
    if (entry.loaded) entry.permissionError = 'Could not refresh session permission. Choose a permission or reload the session.';
    if (isCurrent(workspaceId, sessionId)) showError('Could not load session: ' + error.message);
    return false;
  } finally {
    if (entry.request === request) entry.loading = false;
    if (isCurrent(workspaceId, sessionId)) renderAll();
  }
}
async function createSession() {
  const workspaceId = state.workspaceId;
  if (!workspaceId || state.creatingSession || state.sessionsLoading) return;
  const selection = state.selectionVersion; state.creatingSession = true; renderAll();
  try {
    const body = await api(apiPath(workspaceId), jsonOptions('POST', { agent: state.creationAgent || 'default', model: state.creationBinding || { version: 2, kind: 'agent' } }));
    if (!body.session || typeof body.session.id !== 'string') throw new Error('The server did not return a session ID.');
    if (state.workspaceId !== workspaceId) return;
    const session = body.session; state.sessions.unshift(session);
    if (selection === state.selectionVersion) selectSession(session.id);
    await loadSessions(workspaceId, false);
  } catch (error) { if (state.workspaceId === workspaceId) showError('Could not create session: ' + error.message); }
  finally { state.creatingSession = false; renderAll(); }
}
async function sendMessage(event) {
  event.preventDefault();
  const workspaceId = state.workspaceId; const sessionId = state.sessionId; const text = $('prompt').value.trim();
  if (!workspaceId || !sessionId || !text) return;
  const key = sessionKey(workspaceId, sessionId); const entry = getEntry(workspaceId, sessionId);
  if (!entry.loaded || entry.loading || entry.permissionSaving || entry.agentSaving || entry.modelSaving || !isPermissionPreset(entry.permission?.preset) || !entry.agent || !entry.binding || state.runs.has(key)) return;
  const userItem = { kind: 'user', text: text }; entry.transcript.push(userItem); entry.outcome = ''; entry.todos = null;
  const run = { transcript: entry.transcript, streamItem: null, stopping: false, finishing: false, error: '', reason: '', approval: null, planReview: null };
  state.runs.set(key, run); state.drafts.set(key, ''); $('prompt').value = ''; state.alert = ''; renderAll(true);
  let accepted = false;
  try {
    const response = await fetch(apiPath(workspaceId, sessionId, 'messages'), jsonOptions('POST', { text: text }));
    if (!response.ok) {
      const message = await responseError(response);
      throw new Error(response.status === 409 ? 'Another turn is already running. ' + message : message);
    }
    accepted = true;
    if (!response.body) throw new Error('The server returned an empty event stream.');
    const parser = createSSEParser(agentEvent => {
      applyAgentEvent(run, agentEvent);
      if (agentEvent.type === 'tool.result' && typeof agentEvent.result?.name === 'string') {
        const name = agentEvent.result.name;
        if (name === 'todo_write' || name === 'exit_plan_mode') void refreshSessionBrief(workspaceId, sessionId);
        if (['subagent', 'send_message', 'interrupt_agent'].includes(name)) void refreshSubagentSessions(workspaceId);
      }
      if (isCurrent(workspaceId, sessionId)) queueRender();
    });
    const reader = response.body.getReader(); const decoder = new TextDecoder();
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        parser.push(decoder.decode(part.value, { stream: true }));
      }
      parser.push(decoder.decode()); parser.finish();
    } finally { reader.releaseLock(); }
    if (!run.reason) throw new Error('The event stream ended before the turn finished.');
    if (run.error) { entry.outcome = 'error'; if (isCurrent(workspaceId, sessionId)) showError(run.error); }
    else if (run.reason === 'interrupted') entry.outcome = 'interrupted';
    else if (run.reason === 'error') entry.outcome = 'error';
  } catch (error) {
    entry.outcome = 'error';
    if (!accepted) {
      const index = entry.transcript.indexOf(userItem); if (index >= 0) entry.transcript.splice(index, 1);
      if (!state.drafts.get(key)) { state.drafts.set(key, text); if (isCurrent(workspaceId, sessionId)) $('prompt').value = text; }
    }
    if (isCurrent(workspaceId, sessionId)) showError('Could not complete turn: ' + error.message);
  } finally {
    run.finishing = true; run.approval = null; run.planReview = null;
    if (isCurrent(workspaceId, sessionId)) renderAll();
    await loadDetail(workspaceId, sessionId, true);
    state.runs.delete(key);
    if (state.workspaceId === workspaceId) { await loadSessions(workspaceId, false); void refreshSessionBrief(workspaceId, sessionId); }
    if (isCurrent(workspaceId, sessionId)) renderAll(true);
  }
}
async function stopTurn() {
  const workspaceId = state.workspaceId; const sessionId = state.sessionId; const run = currentRun();
  if (!run || run.stopping || run.finishing) return;
  const approval = run.approval; const review = run.planReview;
  run.stopping = true; renderAll();
  try {
    await api(apiPath(workspaceId, sessionId, 'interrupt'), jsonOptions('POST', {}));
    if (run.approval === approval) run.approval = null;
    if (run.planReview === review) run.planReview = null;
  }
  catch (error) { run.stopping = false; if (isCurrent(workspaceId, sessionId)) showError('Could not stop turn: ' + error.message); }
  finally { if (isCurrent(workspaceId, sessionId)) renderAll(); }
}
function renderApproval() {
  const run = currentRun(); const approval = run?.stopping || run?.finishing ? null : run?.approval;
  $('approval').hidden = !approval;
  if (!approval) return;
  $('approval-tool').textContent = typeof approval.call?.name === 'string' ? approval.call.name : 'Tool';
  $('approval-reason').textContent = approval.reason;
  $('approval-arguments').textContent = stringify(approval.call?.arguments ?? {});
  $('approval-error').textContent = approval.error; $('approval-error').hidden = !approval.error;
  $('approval-allow').disabled = approval.pending; $('approval-reject').disabled = approval.pending;
}
async function resolveApproval(decision) {
  const workspaceId = state.workspaceId; const sessionId = state.sessionId; const run = currentRun(); const approval = run?.approval;
  if (!approval || approval.pending || !['allow', 'deny'].includes(decision) || run.stopping || run.finishing) return;
  approval.pending = true; approval.error = ''; renderApproval();
  try {
    await api(apiPath(workspaceId, sessionId, 'approvals'), jsonOptions('POST', { requestId: approval.requestId, decision: decision }));
    if (run.approval === approval) run.approval = null;
  } catch (error) {
    if (run.approval === approval) { approval.pending = false; approval.error = 'Could not submit decision: ' + error.message; }
  } finally { if (isCurrent(workspaceId, sessionId)) { renderHeader(); renderComposer(); } }
}
function renderTodos() {
  const entry = currentEntry(); const todos = entry?.todos;
  const panel = $('todo-panel');
  panel.hidden = !todos || todos.length === 0;
  if (panel.hidden) { $('todo-list').replaceChildren(); $('todo-counts').textContent = ''; return; }
  $('todo-list').replaceChildren();
  const completed = todos.filter(item => item.status === 'completed').length;
  const active = todos.filter(item => item.status === 'in_progress').length;
  $('todo-counts').textContent = completed + '/' + todos.length + ' done' + (active ? ' · ' + active + ' in progress' : '');
  for (const item of todos) {
    const row = element('li', 'todo-item ' + item.status);
    const mark = element('span', 'todo-mark', item.status === 'completed' ? '✓' : item.status === 'in_progress' ? '▸' : '○');
    mark.setAttribute('aria-hidden', 'true');
    row.append(mark, element('span', '', item.content));
    $('todo-list').append(row);
  }
}
function renderPlanReview() {
  const run = currentRun(); const review = run?.stopping || run?.finishing ? null : run?.planReview;
  $('plan-review').hidden = !review;
  if (!review) { $('plan-review').dataset.requestId = ''; return; }
  if ($('plan-review').dataset.requestId !== review.requestId) {
    $('plan-review').dataset.requestId = review.requestId;
    $('plan-review-feedback').value = review.feedback || '';
  }
  $('plan-review-content').textContent = review.plan;
  $('plan-review-error').textContent = review.error; $('plan-review-error').hidden = !review.error;
  $('plan-review-keep').disabled = review.pending; $('plan-review-approve').disabled = review.pending;
}
async function resolvePlanReview(approved) {
  const workspaceId = state.workspaceId; const sessionId = state.sessionId; const run = currentRun(); const review = run?.planReview;
  if (!review || review.pending || typeof approved !== 'boolean' || run.stopping || run.finishing) return;
  review.feedback = $('plan-review-feedback').value.trim().slice(0, 4000);
  review.pending = true; review.error = ''; renderPlanReview();
  try {
    const payload = { requestId: review.requestId, approved: approved, ...(review.feedback ? { feedback: review.feedback } : {}) };
    await api(apiPath(workspaceId, sessionId, 'plan-review'), jsonOptions('POST', payload));
    if (run.planReview === review) run.planReview = null;
    if (approved) setTimeout(() => { void refreshSessionBrief(workspaceId, sessionId); }, 250);
  } catch (error) {
    if (run.planReview === review) { review.pending = false; review.error = 'Could not submit plan review: ' + error.message; }
  } finally { if (isCurrent(workspaceId, sessionId)) { renderHeader(); renderComposer(); } }
}
async function togglePlan() {
  const workspaceId = state.workspaceId; const sessionId = state.sessionId; const entry = currentEntry(); const run = currentRun();
  if (!workspaceId || !sessionId || !entry?.loaded || entry.loading || run || entry.planSaving) return;
  const active = !entry.plan?.active;
  entry.planSaving = true; entry.planError = ''; renderComposer();
  try {
    const body = await api(apiPath(workspaceId, sessionId, 'plan'), jsonOptions('POST', { active: active }));
    if (state.entries.get(sessionKey(workspaceId, sessionId)) === entry) entry.plan = normalizePlan(body.plan);
  } catch (error) {
    if (state.entries.get(sessionKey(workspaceId, sessionId)) === entry) entry.planError = 'Could not change plan mode: ' + error.message;
  } finally {
    if (state.entries.get(sessionKey(workspaceId, sessionId)) === entry) entry.planSaving = false;
    if (isCurrent(workspaceId, sessionId)) renderComposer();
  }
}
async function refreshSessionBrief(workspaceId, sessionId) {
  try {
    const body = await api(apiPath(workspaceId, sessionId));
    if (!isCurrent(workspaceId, sessionId)) return;
    const entry = state.entries.get(sessionKey(workspaceId, sessionId));
    if (!entry) return;
    entry.plan = normalizePlan(body.plan);
    entry.todos = normalizeTodos(body.todos);
    renderComposer();
  } catch (_) {}
}
let subagentsRefreshedAt = 0;
async function refreshSubagentSessions(workspaceId) {
  if (Date.now() - subagentsRefreshedAt < 750) return;
  subagentsRefreshedAt = Date.now();
  try {
    const body = await api(apiPath(workspaceId));
    if (state.workspaceId !== workspaceId) return;
    state.sessions = (Array.isArray(body.sessions) ? body.sessions : []).slice().sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
    renderSidebar();
  } catch (_) {}
}
const permissionPresets = {
  'read-only': { label: 'Read Only', description: 'File writes are denied in the standing sandbox.' },
  'workspace-write': { label: 'Workspace Write', description: 'Write inside the workspace and permitted temporary directories; wider retries require approval.' },
  'danger-full-access': { label: 'Full access', description: 'Full file access without approval prompts.' },
};
function isPermissionPreset(value) { return typeof value === 'string' && Object.hasOwn(permissionPresets, value); }
function closePermissionMenu(scope) {
  const prefix = scope === 'default' ? 'permission-default' : 'permission-session';
  $(prefix + '-menu').hidden = true;
  $(scope === 'default' ? 'permission-default-entry' : 'permission-entry').setAttribute('aria-expanded', 'false');
}
function togglePermissionMenu(scope) {
  const button = $(scope === 'default' ? 'permission-default-entry' : 'permission-entry');
  if (button.disabled) return;
  const menu = $('permission-' + scope + '-menu'); const opening = menu.hidden;
  closePermissionMenu(scope === 'default' ? 'session' : 'default');
  menu.hidden = !opening; button.setAttribute('aria-expanded', String(opening));
}
function renderDefaultPermission() {
  const preset = state.permissions?.defaultPreset;
  $('permission-default-current').textContent = state.permissionsLoading ? 'Loading' : state.permissionsError ? 'Unavailable' : isPermissionPreset(preset) ? permissionPresets[preset].label : 'Select permission';
  $('permission-default-entry').disabled = state.permissionsLoading || state.permissionsSaving || !!state.permissionsError || !state.permissions;
  for (const id of Object.keys(permissionPresets)) $('permission-default-' + id).setAttribute('aria-checked', String(preset === id));
  if ($('permission-default-entry').disabled) closePermissionMenu('default');
}
function validatePermissionSettings(settings) {
  if (!settings || !Object.hasOwn(settings, 'defaultPreset') || settings.defaultPreset !== null && !isPermissionPreset(settings.defaultPreset) || typeof settings.requiresSelection !== 'boolean') throw new Error('Invalid permission settings response.');
  return { defaultPreset: settings.defaultPreset, requiresSelection: settings.requiresSelection };
}
function defaultPermissionError(message) { $('permission-error').textContent = message; $('permission-error').hidden = !message; }
async function loadPermissions() {
  if (state.permissionsSaving) return;
  const request = ++state.permissionRequest; state.permissionsLoading = true; state.permissionsError = ''; defaultPermissionError(''); renderDefaultPermission();
  try {
    const body = await api('/api/settings/permissions');
    if (request !== state.permissionRequest) return;
    state.permissions = validatePermissionSettings(body.settings);
  } catch (error) {
    if (request !== state.permissionRequest) return;
    state.permissionsError = error.message; defaultPermissionError('Could not load permissions: ' + error.message);
  } finally {
    if (request === state.permissionRequest) { state.permissionsLoading = false; renderDefaultPermission(); }
  }
}
async function saveDefaultPermission(preset) {
  if (!isPermissionPreset(preset) || state.permissionsLoading || state.permissionsSaving || !state.permissions || state.permissionsError) return;
  state.permissionRequest++; state.permissionsSaving = true; $('permission-saved').textContent = ''; defaultPermissionError(''); renderDefaultPermission();
  try {
    const body = await api('/api/settings/permissions', jsonOptions('PUT', { defaultPreset: preset }));
    state.permissions = validatePermissionSettings(body.settings); $('permission-saved').textContent = 'Saved';
  } catch (error) { defaultPermissionError('Could not save permissions: ' + error.message); }
  finally { state.permissionsSaving = false; renderDefaultPermission(); }
}
async function saveSessionPermission(workspaceId, sessionId, entry, preset) {
  const key = sessionKey(workspaceId, sessionId);
  if (!isPermissionPreset(preset) || state.entries.get(key) !== entry || !entry.loaded || entry.loading || entry.permissionSaving || state.runs.has(key)) return;
  entry.permissionSaving = true; entry.permissionError = ''; entry.request++; if (isCurrent(workspaceId, sessionId)) renderComposer();
  try {
    const body = await api(apiPath(workspaceId, sessionId, 'permission'), jsonOptions('POST', { preset: preset }));
    if (!body.permission || !isPermissionPreset(body.permission.preset)) throw new Error('Invalid session permission response.');
    entry.permission = { preset: body.permission.preset };
  } catch (error) { entry.permissionError = 'Could not change permission: ' + error.message; }
  finally { entry.permissionSaving = false; if (isCurrent(workspaceId, sessionId)) renderComposer(); }
}
const reasoningEfforts = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const agentUsages = ['primary', 'subagent', 'both'];
function validateAgentSummary(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)
    || typeof value.id !== 'string' || !value.id.trim()
    || typeof value.name !== 'string' || !value.name.trim()
    || typeof value.description !== 'string'
    || typeof value.role !== 'string'
    || !agentUsages.includes(value.usage)
    || typeof value.profile !== 'string'
    || typeof value.valid !== 'boolean'
    || !Array.isArray(value.warnings) || !value.warnings.every(item => typeof item === 'string')) throw new Error('Invalid session agent response.');
  return { id: value.id, name: value.name, description: value.description, role: value.role, usage: value.usage, profile: value.profile, valid: value.valid, warnings: value.warnings.slice() };
}
function validateAgentOption(value) {
  const agent = validateAgentSummary(value);
  if (!agent) throw new Error('Invalid agent catalog response.');
  return agent;
}
function validateRole(value) {
  if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !value.id.trim()
    || typeof value.name !== 'string' || typeof value.provider !== 'string' || !value.provider.trim()
    || typeof value.model !== 'string' || !value.model.trim()
    || value.reasoningEffort !== undefined && !reasoningEfforts.includes(value.reasoningEffort)) throw new Error('Invalid role catalog response.');
  return { id: value.id, name: value.name, provider: value.provider, model: value.model, ...(value.reasoningEffort === undefined ? {} : { reasoningEffort: value.reasoningEffort }) };
}
function validateModelChoice(value) {
  if (!value || typeof value !== 'object' || typeof value.provider !== 'string' || !value.provider.trim() || typeof value.model !== 'string' || !value.model.trim() || typeof value.name !== 'string' || !value.name.trim()) throw new Error('Invalid model catalog response.');
  return {
    provider: value.provider, model: value.model, name: value.name,
    ...(typeof value.contextWindow === 'number' && Number.isFinite(value.contextWindow) && value.contextWindow > 0 ? { contextWindow: value.contextWindow } : {}),
    ...(typeof value.maxTokens === 'number' && Number.isFinite(value.maxTokens) && value.maxTokens > 0 ? { maxTokens: value.maxTokens } : {}),
    ...(value.capabilities && typeof value.capabilities === 'object' && typeof value.capabilities.imageInput === 'boolean' ? { capabilities: { imageInput: value.capabilities.imageInput } } : {}),
    ...(Array.isArray(value.reasoningEfforts) && value.reasoningEfforts.every(item => reasoningEfforts.includes(item)) ? { reasoningEfforts: value.reasoningEfforts.slice() } : {}),
    ...(reasoningEfforts.includes(value.defaultReasoningEffort) ? { defaultReasoningEffort: value.defaultReasoningEffort } : {}),
  };
}
function validateModelBinding(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value) || value.version !== 2) throw new Error('Invalid session model response.');
  if (value.kind === 'agent') return { version: 2, kind: 'agent' };
  if (value.kind === 'role' && typeof value.role === 'string' && value.role.trim()) return { version: 2, kind: 'role', role: value.role };
  if (value.kind === 'model' && typeof value.provider === 'string' && value.provider.trim()
    && typeof value.model === 'string' && value.model.trim()
    && (value.reasoningEffort === undefined || reasoningEfforts.includes(value.reasoningEffort))) {
    return { version: 2, kind: 'model', provider: value.provider, model: value.model, ...(value.reasoningEffort === undefined ? {} : { reasoningEffort: value.reasoningEffort }) };
  }
  throw new Error('Invalid session model response.');
}
function validateResolvedModel(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value) || typeof value.provider !== 'string' || typeof value.model !== 'string' || typeof value.name !== 'string') return null;
  return {
    provider: value.provider, model: value.model, name: value.name,
    ...(value.reasoningEffort === undefined ? {} : { reasoningEffort: value.reasoningEffort }),
    ...(typeof value.contextWindow === 'number' ? { contextWindow: value.contextWindow } : {}),
    ...(value.capabilities && typeof value.capabilities.imageInput === 'boolean' ? { capabilities: { imageInput: value.capabilities.imageInput } } : {}),
  };
}
function bindingValue(binding) { return binding ? JSON.stringify(binding) : ''; }
function bindingMatches(left, right) { return !!left && !!right && JSON.stringify(left) === JSON.stringify(right); }
function modelValue(model) { return model ? model.provider + ' · ' + model.name : ''; }
function currentAgentId(entry) { return entry?.agent?.id || state.creationAgent || 'default'; }
function currentBinding(entry) { return entry ? entry.binding : state.creationBinding; }
function renderAgentPicker(entry, disabled, creating) {
  const select = $('agent-select'); select.replaceChildren();
  if (state.agentsLoading) {
    const option = element('option', '', 'Loading agents…'); option.value = ''; select.append(option);
    select.disabled = true; return;
  }
  if (state.agentsError) {
    const option = element('option', '', 'Agents unavailable'); option.value = ''; select.append(option);
    select.disabled = true; select.title = 'Could not load agents: ' + state.agentsError; return;
  }
  const rootAgents = state.agents.filter(agent => agent.usage !== 'subagent');
  if (entry && !entry.agent) {
    const option = element('option', '', 'Select an agent'); option.value = ''; option.disabled = true; select.append(option);
  }
  for (const agent of rootAgents) {
    const option = element('option', '', agent.name + (agent.role ? ' · ' + agent.role : ''));
    option.value = agent.id; option.disabled = !agent.valid;
    option.title = [agent.id, agent.description, agent.valid ? '' : (agent.warnings.join('; '))].filter(Boolean).join(' · ');
    select.append(option);
  }
  const wanted = entry?.agent?.id || (creating ? state.creationAgent : '');
  if (wanted && !rootAgents.some(agent => agent.id === wanted)) {
    const option = element('option', '', 'Unavailable · ' + wanted); option.value = wanted; option.disabled = true; select.append(option);
  }
  select.disabled = disabled;
  select.value = wanted && (rootAgents.some(agent => agent.id === wanted) || wanted === entry?.agent?.id) ? wanted : '';
  select.title = entry?.agent
    ? 'Agent for this session: ' + entry.agent.name + ' · role ' + entry.agent.role
    : creating ? 'Agent for the next session' : 'Select an agent for this session';
}
function renderModelPicker(entry, disabled, creating) {
  const select = $('model-select'); select.replaceChildren();
  if (state.modelsLoading || state.rolesLoading) {
    const option = element('option', '', 'Loading models…'); option.value = ''; select.append(option);
    select.disabled = true; return;
  }
  if (state.modelsError || state.rolesError) {
    const option = element('option', '', 'Models unavailable'); option.value = ''; select.append(option);
    select.disabled = true; select.title = 'Could not load models: ' + (state.modelsError || state.rolesError); return;
  }
  const current = currentBinding(entry);
  if (entry && !current) {
    const option = element('option', '', 'Select a model'); option.value = ''; option.disabled = true; select.append(option);
  }
  const follow = { version: 2, kind: 'agent' };
  const followOption = element('option', '', 'Follow agent');
  followOption.value = bindingValue(follow); select.append(followOption);
  if (state.roles.length) {
    const group = element('optgroup'); group.label = 'Roles';
    for (const role of state.roles) {
      const option = element('option', '', role.name + ' · ' + role.provider + '/' + role.model + (role.reasoningEffort ? ' · ' + role.reasoningEffort : ''));
      option.value = bindingValue({ version: 2, kind: 'role', role: role.id });
      option.title = 'Role ' + role.id;
      group.append(option);
    }
    select.append(group);
  }
  if (state.models.length) {
    const group = element('optgroup'); group.label = 'Models';
    for (const choice of state.models) {
      const option = element('option', '', choice.provider + ' · ' + choice.name + (choice.defaultReasoningEffort ? ' · ' + choice.defaultReasoningEffort : ''));
      option.value = bindingValue({ version: 2, kind: 'model', provider: choice.provider, model: choice.model, ...(choice.defaultReasoningEffort === undefined ? {} : { reasoningEffort: choice.defaultReasoningEffort }) });
      option.title = choice.provider + ' · ' + choice.model
        + (choice.contextWindow ? ' · ' + choice.contextWindow + ' context tokens' : '')
        + (choice.capabilities?.imageInput ? ' · image input' : '');
      group.append(option);
    }
    select.append(group);
  }
  if (current && !bindingMatches(current, follow) && !(current.kind === 'role' && state.roles.some(role => role.id === current.role))
    && !(current.kind === 'model' && state.models.some(choice => choice.provider === current.provider && choice.model === current.model))) {
    const option = element('option', '', 'Unavailable · ' + (current.kind === 'role' ? current.role : current.provider + '/' + current.model));
    option.value = bindingValue(current); option.disabled = true; select.append(option);
  }
  select.disabled = disabled;
  select.value = bindingValue(current);
  select.title = creating ? 'Model source for the next session'
    : current?.kind === 'agent' ? 'Model follows the selected agent role'
    : current?.kind === 'role' ? 'Model follows role ' + current.role
    : current ? 'Explicit model ' + current.provider + '/' + current.model
    : 'Select a model source for this session';
}
async function loadCatalogs() {
  state.modelsLoading = true; state.agentsLoading = true; state.rolesLoading = true;
  state.modelsError = ''; state.agentsError = ''; state.rolesError = '';
  renderComposer();
  const [models, agents, roles] = await Promise.allSettled([api('/api/models'), api('/api/agents'), api('/api/roles')]);
  if (models.status === 'fulfilled' && models.value && Array.isArray(models.value.models)) {
    try { state.models = models.value.models.map(validateModelChoice); } catch (error) { state.models = []; state.modelsError = error.message; }
  } else { state.models = []; state.modelsError = models.status === 'rejected' ? models.reason.message : 'The server did not return a model catalog.'; }
  if (agents.status === 'fulfilled' && agents.value && Array.isArray(agents.value.agents)) {
    try { state.agents = agents.value.agents.map(validateAgentOption); } catch (error) { state.agents = []; state.agentsError = error.message; }
  } else { state.agents = []; state.agentsError = agents.status === 'rejected' ? agents.reason.message : 'The server did not return an agent catalog.'; }
  if (roles.status === 'fulfilled' && roles.value && Array.isArray(roles.value.roles)) {
    try { state.roles = roles.value.roles.map(validateRole); } catch (error) { state.roles = []; state.rolesError = error.message; }
  } else { state.roles = []; state.rolesError = roles.status === 'rejected' ? roles.reason.message : 'The server did not return a role catalog.'; }
  state.modelsLoading = false; state.agentsLoading = false; state.rolesLoading = false;
  renderComposer();
}
async function saveSessionAgent(value) {
  const workspaceId = state.workspaceId; const sessionId = state.sessionId;
  if (!workspaceId || !sessionId) {
    if (value) { state.creationAgent = value; renderComposer(); }
    return;
  }
  const key = sessionKey(workspaceId, sessionId); const entry = state.entries.get(key);
  if (!entry || entry.loading || entry.permissionSaving || entry.agentSaving || entry.modelSaving || state.runs.has(key)) return;
  if (entry.agent?.id === value) return;
  if (!state.agents.some(agent => agent.id === value && agent.valid && agent.usage !== 'subagent')) return;
  entry.agentSaving = true; entry.agentError = ''; entry.request++; if (isCurrent(workspaceId, sessionId)) renderComposer();
  let reload = false;
  try {
    const body = await api(apiPath(workspaceId, sessionId, 'agent'), jsonOptions('POST', { agent: value }));
    const agent = validateAgentSummary(body.agent);
    if (!agent || agent.id !== value) throw new Error('The server returned a different agent selection.');
    entry.agent = agent; entry.agentWarnings = agent.warnings.slice(); reload = true;
  } catch (error) { entry.agentError = 'Could not change agent: ' + error.message; }
  finally {
    entry.agentSaving = false;
    if (reload) await loadDetail(workspaceId, sessionId, true);
    if (isCurrent(workspaceId, sessionId)) renderComposer();
  }
}
async function saveSessionModel(value) {
  let binding;
  try { binding = validateModelBinding(JSON.parse(value)); } catch (_) { return; }
  if (!binding) return;
  const workspaceId = state.workspaceId; const sessionId = state.sessionId;
  if (!workspaceId || !sessionId) { state.creationBinding = binding; renderComposer(); return; }
  const key = sessionKey(workspaceId, sessionId); const entry = state.entries.get(key);
  if (!entry || entry.loading || entry.permissionSaving || entry.agentSaving || entry.modelSaving || state.runs.has(key)) return;
  if (bindingMatches(entry.binding, binding)) return;
  entry.modelSaving = true; entry.modelError = ''; entry.request++; if (isCurrent(workspaceId, sessionId)) renderComposer();
  try {
    const body = await api(apiPath(workspaceId, sessionId, 'model'), jsonOptions('POST', binding));
    const selected = validateModelBinding(body.model);
    if (!bindingMatches(selected, binding)) throw new Error('The server returned a different model binding.');
    entry.binding = selected; entry.resolvedModel = validateResolvedModel(body.resolvedModel);
  } catch (error) { entry.modelError = 'Could not change model: ' + error.message; }
  finally { entry.modelSaving = false; if (isCurrent(workspaceId, sessionId)) renderComposer(); }
}
function closePermissionConfirmation(scope) {
  if (!state.permissionConfirmation || scope && state.permissionConfirmation.scope !== scope) return;
  state.permissionConfirmation = null; $('permission-risk-ack').checked = false;
  if ($('permission-risk-dialog').open) $('permission-risk-dialog').close();
}
function choosePermission(scope, preset) {
  if (!isPermissionPreset(preset)) return;
  if (scope === 'default') {
    if (state.permissionsLoading || state.permissionsSaving || !state.permissions || state.permissionsError) return;
    closePermissionMenu(scope);
    if (state.permissions.defaultPreset === preset) return;
  } else {
    const entry = currentEntry();
    if (!state.workspaceId || !state.sessionId || !entry?.loaded || entry.loading || entry.permissionSaving || currentRun()) return;
    closePermissionMenu(scope);
    if (entry.permission?.preset === preset) return;
  }
  if (preset === 'danger-full-access') {
    state.permissionConfirmation = scope === 'default' ? { scope: scope } : { scope: scope, workspaceId: state.workspaceId, sessionId: state.sessionId, entry: currentEntry() };
    $('permission-risk-description').textContent = scope === 'default' ? 'Full access lets new sessions modify files without file sandbox restrictions or approval prompts, including sensitive files and external commands. Only use it when you trust subsequent tasks.' : 'Full access lets this session modify files without file sandbox restrictions or approval prompts, including sensitive files and external commands. Only use it when you trust the current task.';
    $('permission-risk-ack').checked = false; $('permission-risk-confirm').disabled = true; $('permission-risk-dialog').showModal();
    return;
  }
  if (scope === 'default') saveDefaultPermission(preset);
  else saveSessionPermission(state.workspaceId, state.sessionId, currentEntry(), preset);
}
function confirmPermission() {
  const confirmation = state.permissionConfirmation;
  if (!confirmation || !$('permission-risk-ack').checked) return;
  closePermissionConfirmation();
  if (confirmation.scope === 'default') saveDefaultPermission('danger-full-access');
  else if (isCurrent(confirmation.workspaceId, confirmation.sessionId)) saveSessionPermission(confirmation.workspaceId, confirmation.sessionId, confirmation.entry, 'danger-full-access');
}
function openSettings() { if (!$('settings-dialog').open) $('settings-dialog').showModal(); $('permission-saved').textContent = ''; loadPermissions(); }
function closeSessionMenu() { $('session-menu').hidden = true; $('session-actions').setAttribute('aria-expanded', 'false'); }
async function exportSession(format) {
  const workspaceId = state.workspaceId; const sessionId = state.sessionId;
  if (!workspaceId || !sessionId) return;
  closeSessionMenu();
  try {
    const response = await fetch(apiPath(workspaceId, sessionId, 'export') + '?format=' + format);
    if (!response.ok) throw new Error(await responseError(response));
    if (format === 'markdown') {
      const text = await response.text();
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable.');
      await navigator.clipboard.writeText(text);
    } else {
      const blob = await response.blob(); const url = URL.createObjectURL(blob); const link = document.createElement('a');
      link.href = url; link.download = 'omniagent-session-transcript.json'; link.click(); URL.revokeObjectURL(url);
    }
  } catch (error) { if (isCurrent(workspaceId, sessionId)) showError('Could not export session: ' + error.message); }
}
function openWorkspaceDialog() { $('workspace-form').reset(); $('workspace-error').hidden = true; $('workspace-dialog').showModal(); $('workspace-input').focus(); }
async function addWorkspace(event) {
  event.preventDefault();
  const path = $('workspace-input').value.trim(); const name = $('workspace-name').value.trim();
  if (!path) { $('workspace-input').focus(); return; }
  $('workspace-error').hidden = true; $('save-workspace').disabled = true;
  try {
    const body = await api('/api/workspaces', jsonOptions('POST', name ? { path: path, name: name } : { path: path }));
    if (!body.workspace || typeof body.workspace.id !== 'string') throw new Error('The server did not return a workspace.');
    $('workspace-dialog').close(); await loadWorkspaces(body.workspace.id); closeDrawer();
  } catch (error) { $('workspace-error').textContent = error.message; $('workspace-error').hidden = false; }
  finally { $('save-workspace').disabled = false; }
}
function openRemoveDialog() {
  const workspace = workspaceById(state.workspaceId); if (!workspace) return;
  $('remove-dialog').dataset.workspaceId = workspace.id;
  $('remove-description').textContent = 'Unregister ' + (workspace.name || workspace.path || workspace.id) + '? Its directory and saved sessions will not be deleted.';
  $('remove-error').hidden = true; $('remove-dialog').showModal();
}
async function removeWorkspace() {
  const workspaceId = $('remove-dialog').dataset.workspaceId; if (!workspaceId) return;
  $('confirm-remove').disabled = true; $('remove-error').hidden = true;
  try {
    await api('/api/workspaces/' + encodeURIComponent(workspaceId), { method: 'DELETE' });
    $('remove-dialog').close(); delete state.selectedByWorkspace[workspaceId];
    for (const key of state.entries.keys()) if (JSON.parse(key)[0] === workspaceId) { state.entries.delete(key); state.drafts.delete(key); }
    if (state.workspaceId === workspaceId) { state.workspaceId = null; state.sessionId = null; state.sessions = []; state.sessionRequest++; }
    persistSelection(); await loadWorkspaces();
  } catch (error) { $('remove-error').textContent = error.message; $('remove-error').hidden = false; }
  finally { $('confirm-remove').disabled = false; }
}
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const target = theme === 'dark' ? 'light' : 'dark';
  $('theme').setAttribute('aria-label', 'Switch to ' + target + ' theme'); $('theme').title = 'Switch to ' + target + ' theme';
  storageSet('omniagent.theme', theme);
}
function boot() {
  try { const saved = JSON.parse(storageGet('omniagent.activeSessions') || '{}'); if (saved && typeof saved === 'object' && !Array.isArray(saved)) state.selectedByWorkspace = saved; } catch (_) {}
  const theme = storageGet('omniagent.theme'); applyTheme(theme === 'dark' || theme === 'light' ? theme : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  $('theme').addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
  $('drawer-toggle').addEventListener('click', () => $('app').classList.contains('drawer-open') ? closeDrawer() : openDrawer());
  $('drawer-backdrop').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && $('app').classList.contains('drawer-open')) closeDrawer(); });
  $('workspace-select').addEventListener('change', event => selectWorkspace(event.target.value));
  $('add-workspace').addEventListener('click', openWorkspaceDialog);
  $('remove-workspace').addEventListener('click', openRemoveDialog);
  $('new-session').addEventListener('click', createSession);
  $('session-search').addEventListener('input', renderSidebar);
  $('dismiss-alert').addEventListener('click', () => { state.alert = ''; renderAlert(); });
  $('tab-conversation').addEventListener('click', () => setTab('conversation'));
  $('tab-observe').addEventListener('click', () => setTab('observe'));
  for (const name of ['conversation', 'observe']) $('tab-' + name).addEventListener('keydown', event => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); const next = name === 'conversation' ? 'observe' : 'conversation'; setTab(next); $('tab-' + next).focus(); }
  });
  for (const name of ['records', 'events']) $('trajectory-' + name).addEventListener('click', () => { state.trajectoryView = name; renderObserve(); });
  $('event-filter').addEventListener('change', renderObserve); $('event-search').addEventListener('input', renderObserve); $('trace-filter').addEventListener('change', renderObserve); $('trace-search').addEventListener('input', renderObserve); $('timeline-mode').addEventListener('change', renderObserve);
  $('sidebar-toggle').addEventListener('click', () => $('app').classList.toggle('sidebar-expanded'));
  $('open-settings').addEventListener('click', openSettings);
  $('close-settings').addEventListener('click', () => { closePermissionMenu('default'); $('settings-dialog').close(); });
  $('permission-default-entry').addEventListener('click', () => togglePermissionMenu('default'));
  $('permission-entry').addEventListener('click', () => togglePermissionMenu('session'));
  $('agent-select').addEventListener('change', event => saveSessionAgent(event.target.value));
  $('model-select').addEventListener('change', event => saveSessionModel(event.target.value));
  for (const scope of ['default', 'session']) for (const preset of Object.keys(permissionPresets)) $('permission-' + scope + '-' + preset).addEventListener('click', () => choosePermission(scope, preset));
  $('permission-risk-ack').addEventListener('change', () => { $('permission-risk-confirm').disabled = !$('permission-risk-ack').checked; });
  $('permission-risk-confirm').addEventListener('click', confirmPermission);
  for (const id of ['permission-risk-close', 'permission-risk-cancel']) $(id).addEventListener('click', () => closePermissionConfirmation());
  $('permission-risk-dialog').addEventListener('cancel', () => closePermissionConfirmation());
  document.addEventListener('click', event => {
    for (const scope of ['default', 'session']) {
      const trigger = $(scope === 'default' ? 'permission-default-entry' : 'permission-entry');
      if (!trigger.contains(event.target) && !$('permission-' + scope + '-menu').contains(event.target)) closePermissionMenu(scope);
    }
  });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') { closePermissionMenu('default'); closePermissionMenu('session'); } });
  $('approval-allow').addEventListener('click', () => resolveApproval('allow')); $('approval-reject').addEventListener('click', () => resolveApproval('deny'));
  $('plan-toggle').addEventListener('click', togglePlan);
  $('plan-review-approve').addEventListener('click', () => resolvePlanReview(true));
  $('plan-review-keep').addEventListener('click', () => resolvePlanReview(false));
  $('plan-review-feedback').addEventListener('input', () => {
    const review = currentRun()?.planReview;
    if (review) review.feedback = $('plan-review-feedback').value;
  });
  $('session-actions').addEventListener('click', () => { const open = $('session-menu').hidden; $('session-menu').hidden = !open; $('session-actions').setAttribute('aria-expanded', String(open)); });
  $('copy-markdown').addEventListener('click', () => exportSession('markdown')); $('download-json').addEventListener('click', () => exportSession('json'));
  document.addEventListener('click', event => { if (!$('session-actions').contains(event.target) && !$('session-menu').contains(event.target)) closeSessionMenu(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') closeSessionMenu(); });
  $('prompt').addEventListener('input', () => { if (state.workspaceId && state.sessionId) state.drafts.set(sessionKey(state.workspaceId, state.sessionId), $('prompt').value); renderComposer(); });
  $('prompt').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('composer').requestSubmit(); } });
  $('composer').addEventListener('submit', sendMessage); $('stop').addEventListener('click', stopTurn);
  $('workspace-form').addEventListener('submit', addWorkspace);
  for (const id of ['close-workspace-dialog', 'cancel-workspace']) $(id).addEventListener('click', () => $('workspace-dialog').close());
  for (const id of ['close-remove-dialog', 'cancel-remove']) $(id).addEventListener('click', () => $('remove-dialog').close());
  $('confirm-remove').addEventListener('click', removeWorkspace);
  loadPermissions(); loadCatalogs(); loadWorkspaces();
}
boot();
</script>
</body>
</html>`;
