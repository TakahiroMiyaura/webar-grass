// Tap-to-start gate.
//
// This exists because XRExtras.Loading.pipelineModule() breaks rendering on the iOS
// code path (see README "既知の問題"), and that module is also what normally carries the
// one thing iOS genuinely requires: DeviceMotionEvent.requestPermission() only resolves
// when called from a user gesture, and the engine cannot track without motion data.
// So the gate is both the workaround and the permission prompt.

type MotionPermissionApi = {requestPermission?: () => Promise<'granted' | 'denied'>}

const motionApi = (): MotionPermissionApi | null =>
  typeof DeviceMotionEvent === 'undefined'
    ? null
    : (DeviceMotionEvent as unknown as MotionPermissionApi)

/** True only on iOS 13+, where the permission prompt is gated behind a user gesture. */
export const needsMotionPermission = (): boolean =>
  typeof motionApi()?.requestPermission === 'function'

const requestMotionPermission = async (): Promise<boolean> => {
  const api = motionApi()
  if (typeof api?.requestPermission !== 'function') return true
  try {
    return (await api.requestPermission()) === 'granted'
  } catch {
    // Thrown when called outside a user gesture. Treat as "carry on and let the engine
    // report the real failure" rather than blocking a device that might still work.
    return true
  }
}

export interface StartGateOptions {
  onStart: () => void
}

export const showStartGate = ({onStart}: StartGateOptions): void => {
  const gate = document.createElement('div')
  gate.id = 'start-gate'
  gate.innerHTML =
    '<div class="start-gate__body">' +
    '<h1>タップして草を生やす</h1>' +
    '<p>カメラで周囲を映し、画面をタップすると<br>その場所にオブジェクトが生えます。</p>' +
    '<button type="button" id="start-button">はじめる</button>' +
    '<small>カメラと"モーションと画面の向き"の使用を許可してください</small>' +
    '</div>'
  document.body.appendChild(gate)

  const button = gate.querySelector<HTMLButtonElement>('#start-button')!
  button.addEventListener('click', async () => {
    button.disabled = true
    button.textContent = '起動中…'

    const granted = await requestMotionPermission()
    if (!granted) {
      button.disabled = false
      button.textContent = 'もう一度試す'
      gate.querySelector('small')!.textContent =
        'モーションの利用が拒否されました。Safari の設定から許可してください。'
      return
    }

    gate.remove()
    onStart()
  }, {once: false})
}
