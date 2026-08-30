// The debug switch (MYAA-22).
//
// Most of the on-screen controls exist to answer "which method placed this tuft, and
// why" -- the method switch, the calibration button, the measurement panel, the
// placement read-out. That is a developer question. What someone who scanned the QR code
// should see is the camera feed, their grass, and two buttons: reset and clear.
//
// So this is the one place that decides which controls are content and which are tools.
// It flips a class on <body> and the CSS does the hiding, which means a control can be
// reclassified by editing a selector rather than by rewiring whoever built it.
//
// The choice sticks per device (localStorage) so a debugging session survives the reload
// that follows almost every change, and ?debug=1 turns it on without any tapping -- the
// headless checks and a shared link both need that.

const KEY = 'webar-grass:debug'
const CLASS = 'debug-on'

const listeners = new Set<(on: boolean) => void>()

export const isDebugMode = (): boolean => document.body.classList.contains(CLASS)

/** Notifies on every change, including the one initDebugMode() applies at startup. */
export const onDebugModeChange = (fn: (on: boolean) => void): void => { listeners.add(fn) }

export const setDebugMode = (on: boolean): void => {
  if (isDebugMode() === on) return
  document.body.classList.toggle(CLASS, on)
  const box = document.getElementById('debug-toggle') as HTMLInputElement | null
  if (box) box.checked = on
  try { localStorage.setItem(KEY, on ? '1' : '0') } catch { /* private mode, Safari */ }
  for (const fn of listeners) fn(on)
}

const initial = (): boolean => {
  // An explicit ?debug=0 has to be able to switch a stored preference back off, so the
  // parameter is checked for its value rather than merely for its presence.
  const param = new URLSearchParams(location.search).get('debug')
  if (param !== null) return param !== '0' && param !== 'false'
  try { return localStorage.getItem(KEY) === '1' } catch { return false }
}

export const initDebugMode = (): void => {
  const box = document.getElementById('debug-toggle') as HTMLInputElement | null
  if (!box) throw new Error('missing #debug-toggle in index.html')
  box.addEventListener('change', () => setDebugMode(box.checked))
  const on = initial()
  document.body.classList.toggle(CLASS, on)
  box.checked = on
  for (const fn of listeners) fn(on)
}
