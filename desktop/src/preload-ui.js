// Bridge between the Next.js UI and the Electron main process.
const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = new Set([
  'tabs:update', 'tabs:error', 'rec:step', 'rec:state', 'rec:navigated',
  'run:log', 'run:status', 'run:output', 'run:progress', 'engine:progress', 'download:done', 'ui:focus-address', 'ui:new-tab',
]);

const inv = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);

contextBridge.exposeInMainWorld('autobrowser', {
  isDesktop: true,
  backend: inv('backend:info'),
  tabs: {
    list: inv('tabs:list'),
    create: inv('tabs:create'),
    close: inv('tabs:close'),
    activate: inv('tabs:activate'),
    navigate: inv('tabs:navigate'),
    back: inv('tabs:back'),
    forward: inv('tabs:forward'),
    reload: inv('tabs:reload'),
    setProfile: inv('tabs:set-profile'),
    showFirefox: inv('tabs:show-firefox'),
  },
  setPageBounds: inv('ui:page-bounds'),
  previewTemplate: inv('template:preview'),
  engine: { status: inv('engine:status'), installFirefox: inv('engine:install-firefox') },
  profiles: { refresh: inv('profiles:refresh'), clearData: inv('profiles:clear-data') },
  settings: { refresh: inv('settings:refresh') },
  recorder: { start: inv('rec:start'), stop: inv('rec:stop'), setMode: inv('rec:mode') },
  runner: { run: inv('runner:run'), stop: inv('runner:stop') },
  openExternal: inv('shell:open'),
  saveFile: inv('file:save'),
  on(channel, cb) {
    if (!EVENTS.has(channel)) throw new Error(`unknown channel ${channel}`);
    const fn = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, fn);
    return () => ipcRenderer.removeListener(channel, fn);
  },
});
