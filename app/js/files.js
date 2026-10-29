// File input/output that works in a browser, the desktop window and the Android app.

export function readFile(file) {
  if (file.arrayBuffer) return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

export async function saveFile(text, name, mime = 'application/octet-stream') {
  const plugins = window.Capacitor?.Plugins;
  if (window.Capacitor?.isNativePlatform?.() && plugins?.Filesystem) {
    // Android WebView cannot download blobs: write to the app cache, then offer the share sheet (save to Files, Drive, Telegram…).
    const { uri } = await plugins.Filesystem.writeFile({ path: name, data: text, directory: 'CACHE', encoding: 'utf8', recursive: true });
    if (plugins.Share) await plugins.Share.share({ title: name, url: uri }).catch(() => {});
    return uri;
  }
  if (window.pywebview?.api?.save_file) return window.pywebview.api.save_file(name, text);
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return name;
}

// Print a ready report (a complete HTML document, see report.js). The desktop window and the Android
// app have no print dialog: the desktop program opens the report in the system browser, which prints
// it; on Android it is shared as a file to print from there. A desktop browser prints it from a hidden
// frame; phones and Safari print the parent page instead, so there it opens in a new tab.
export async function printReport(html, title) {
  const name = `CardioAI ${title}`.replace(/[^\p{L}\p{N} .-]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) + '.html';
  // Prints once, right after opening — not again when the saved file is reopened later.
  const autoPrint = `<script>if (Date.now() - ${Date.now()} < 120000) addEventListener('load', () => setTimeout(print, 400))</script>`;
  if (window.pywebview?.api?.open_report) return window.pywebview.api.open_report(name, html.replace('</body>', autoPrint + '</body>'));
  if (window.Capacitor?.isNativePlatform?.()) return saveFile(html, name, 'text/html');
  const ua = navigator.userAgent;
  if (/Android|iPhone|iPad|Mobile/.test(ua) || (/Safari\//.test(ua) && !/Chrome|Chromium|Edg\//.test(ua))) {
    const url = URL.createObjectURL(new Blob([html.replace('</body>', autoPrint + '</body>')], { type: 'text/html' }));
    const tab = window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 120000);
    if (!tab) throw Error('браузер заблокировал новую вкладку — разрешите всплывающие окна для этого сайта');
    return name;
  }
  const frame = Object.assign(document.createElement('iframe'), { srcdoc: html, title });
  frame.setAttribute('sandbox', 'allow-same-origin allow-modals');  // the report needs no scripts
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
  await new Promise(resolve => { frame.onload = resolve; document.body.append(frame); });
  frame.contentWindow.addEventListener('afterprint', () => frame.remove());
  setTimeout(() => frame.remove(), 600000);
  frame.contentWindow.focus();
  frame.contentWindow.print();
  return name;
}
