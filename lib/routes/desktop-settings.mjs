// Desktop settings: the four switches the desktop app reads from the saved state file (desktop/main.cjs reads them at the moment
// it needs them, so a change applies with no restart). GET /api/desktop-settings gives the four values, and whether this server
// runs under the desktop app, where the switches have an effect. POST takes any of the four as true or false, saves them, and
// answers the same shape. The server checks the Plenum token and the JSON content type before this handler runs.

const KEYS = ['finishedAlerts', 'approvalAlerts', 'keepAwake', 'trayOnClose'];
const REFUSAL = 'Send true or false for each setting.';

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// The shape both routes answer. Finished, approval and keep-awake default to on; the tray switch defaults to off. Only an
// explicit false turns the first three off, and only an explicit true turns the tray on, as desktop/main.cjs reads them.
export function desktopSettings(st) {
  return {
    finishedAlerts: st.finishedAlerts !== false,
    approvalAlerts: st.approvalAlerts !== false,
    keepAwake: st.keepAwake !== false,
    trayOnClose: st.trayOnClose === true,
    desktop: process.parentPort !== undefined,
  };
}

export const routes = [
  {
    method: 'GET',
    path: '/api/desktop-settings',
    handler: ({ res, json, store }) => json(res, 200, desktopSettings(store.get())),
  },
  {
    // Body: any of the four keys with a boolean. Other keys are ignored. A value that is not a boolean refuses the whole request,
    // so nothing is written from a request that is partly wrong.
    method: 'POST',
    path: '/api/desktop-settings',
    handler: async ({ req, res, json, readBody, httpError, store }) => {
      const body = await readBody(req);
      if (!isObject(body)) throw httpError(400, REFUSAL);
      const picked = KEYS.filter(key => body[key] !== undefined);
      if (picked.some(key => typeof body[key] !== 'boolean')) throw httpError(400, REFUSAL);
      const st = store.get();
      for (const key of picked) st[key] = body[key];
      // A save that did not reach the file answers 500, so the page never says "Saved" for a switch that is lost on restart (B-28). persist
      // resolves to null when the save worked and to the failure message when it did not; this is what store.saveOrFail makes of it.
      if (picked.length > 0) {
        const failure = await store.persist();
        if (failure) throw httpError(500, `${failure} The change is shown but is lost on restart until a save works.`);
      }
      return json(res, 200, desktopSettings(store.get()));
    },
  },
];
