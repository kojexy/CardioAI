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
