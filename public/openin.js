// In-app browser guard.
//
// QR codes get scanned inside LINE / Instagram / Facebook / X, and those apps open
// the link in an embedded webview rather than Safari or Chrome. Those webviews are
// where this experience breaks: getUserMedia is either denied outright or resolves
// to a stream the SLAM pipeline never receives frames from, so the user sees a black
// screen with no explanation. Detect that case up front and hand the user a way out
// instead of letting the camera prompt fail silently.
//
// Loaded as a classic script in <head> so it runs before app.js starts the engine.
(function () {
  var ua = navigator.userAgent || ''
  var isIOS = /iPhone|iPad|iPod/.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  var isAndroid = /Android/.test(ua)

  // Ordered most-specific first: the Facebook and Instagram webviews both carry FBAN/FBAV.
  var APPS = [
    {id: 'line', name: 'LINE', re: /\bLine\//i},
    {id: 'instagram', name: 'Instagram', re: /Instagram/i},
    {id: 'facebook', name: 'Facebook', re: /FBAN|FBAV|FB_IAB|FBIOS/i},
    {id: 'twitter', name: 'X (Twitter)', re: /\bTwitter\b/i},
    {id: 'tiktok', name: 'TikTok', re: /BytedanceWebview|musical_ly|Bytedance/i},
    {id: 'wechat', name: 'WeChat', re: /MicroMessenger/i},
    {id: 'slack', name: 'Slack', re: /\bSlack\b/i},
  ]
  var app = null
  for (var i = 0; i < APPS.length; i++) {
    if (APPS[i].re.test(ua)) { app = APPS[i]; break }
  }

  // Generic iOS webview fallback: a real iOS browser reports Safari/CriOS/FxiOS/EdgiOS.
  // Anything else running WebKit on iOS is an embedded view we cannot trust with the camera.
  if (!app && isIOS && !/Safari|CriOS|FxiOS|EdgiOS|OPiOS/.test(ua)) {
    app = {id: 'ios-webview', name: 'アプリ内ブラウザ', re: null}
  }

  // Generic Android fallback: the "; wv)" token marks an embedded WebView. Chrome proper
  // never sets it, so this catches the long tail of apps without adding false positives.
  if (!app && isAndroid && /;\s*wv\)/.test(ua)) {
    app = {id: 'android-webview', name: 'アプリ内ブラウザ', re: null}
  }

  if (!app) return

  window.__inAppBrowser = app.id
  window.__inAppBlocked = true

  var url = location.href.split('#')[0]

  // LINE honours openExternalBrowser=1 and hands the URL to the OS default browser.
  // This is the only one of these apps with a supported escape hatch, so use it.
  var lineUrl = url + (url.indexOf('?') === -1 ? '?' : '&') + 'openExternalBrowser=1'

  // Android: an intent:// URL launches Chrome directly. S.browser_fallback_url keeps
  // the tap from dead-ending if Chrome is not installed.
  var noScheme = url.replace(/^https?:\/\//, '')
  var intentUrl = 'intent://' + noScheme + '#Intent;scheme=https;package=com.android.chrome;' +
    'S.browser_fallback_url=' + encodeURIComponent(url) + ';end'

  var primary = {label: '', href: ''}
  if (app.id === 'line') {
    primary = {label: 'ブラウザで開く', href: lineUrl}
  } else if (isAndroid) {
    primary = {label: 'Chrome で開く', href: intentUrl}
  } else if (isIOS) {
    // x-safari-https:// is undocumented but works from most iOS embedded webviews.
    // Instagram and Facebook block it, so those users fall through to copy-and-paste.
    primary = {label: 'Safari で開く', href: 'x-safari-' + url}
  }

  var blocked = isIOS && (app.id === 'instagram' || app.id === 'facebook')

  var el = document.createElement('div')
  el.id = 'inapp-guard'
  el.innerHTML =
    '<div class="ig-card">' +
      '<div class="ig-icon">📷</div>' +
      '<h1>' + app.name + ' の中では動きません</h1>' +
      '<p>カメラを使うため、Safari や Chrome で開き直してください。</p>' +
      (blocked
        ? '<p class="ig-note">右下の <b>…</b> から「<b>外部ブラウザで開く</b>」を選んでください。</p>'
        : (primary.href ? '<a class="ig-btn" id="ig-open" href="' + primary.href + '">' + primary.label + '</a>' : '')) +
      '<button class="ig-btn ig-btn-sub" id="ig-copy">URL をコピー</button>' +
      '<div class="ig-url" id="ig-url">' + url + '</div>' +
      '<button class="ig-link" id="ig-ignore">このまま試す</button>' +
    '</div>'

  var css = document.createElement('style')
  css.textContent =
    '#inapp-guard{position:fixed;inset:0;z-index:99999;background:#0d0f12;color:#fff;' +
      'display:flex;align-items:center;justify-content:center;padding:24px;' +
      'font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans","Noto Sans JP",sans-serif;}' +
    '.ig-card{max-width:340px;text-align:center;}' +
    '.ig-icon{font-size:44px;margin-bottom:8px;}' +
    '#inapp-guard h1{font-size:19px;line-height:1.45;margin:0 0 12px;}' +
    '#inapp-guard p{font-size:14px;line-height:1.7;color:#c7cdd6;margin:0 0 16px;}' +
    '.ig-note{background:#1b1f25;border-radius:10px;padding:12px 14px;}' +
    '.ig-note b{color:#fff;}' +
    '.ig-btn{display:block;width:100%;box-sizing:border-box;padding:14px 16px;margin:0 0 10px;' +
      'background:#3ddc84;color:#08120c;font-size:16px;font-weight:700;border:0;border-radius:12px;' +
      'text-decoration:none;cursor:pointer;}' +
    '.ig-btn-sub{background:#252b33;color:#fff;}' +
    '.ig-url{font-size:11px;color:#79828f;word-break:break-all;margin:14px 0 18px;' +
      'user-select:all;-webkit-user-select:all;}' +
    '.ig-link{background:none;border:0;color:#79828f;font-size:13px;text-decoration:underline;cursor:pointer;}'

  function mount() {
    document.head.appendChild(css)
    document.body.appendChild(el)

    var copy = document.getElementById('ig-copy')
    copy.addEventListener('click', function () {
      var done = function () { copy.textContent = 'コピーしました'
        setTimeout(function () { copy.textContent = 'URL をコピー' }, 1800) }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(done, function () { select() })
      } else { select() }
      // Clipboard API is unavailable in several of these webviews; selecting the text
      // at least reduces the escape to a long-press.
      function select() {
        var r = document.createRange()
        r.selectNodeContents(document.getElementById('ig-url'))
        var s = getSelection(); s.removeAllRanges(); s.addRange(r)
        done()
      }
    })

    document.getElementById('ig-ignore').addEventListener('click', function () {
      el.remove()
      window.__inAppBlocked = false
      window.dispatchEvent(new Event('inapp-dismissed'))
    })
  }

  if (document.body) mount()
  else document.addEventListener('DOMContentLoaded', mount, {once: true})
})()
