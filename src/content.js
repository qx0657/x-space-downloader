// Content scripts can't be ES modules, so this loader pulls the real panel in with import().
import(chrome.runtime.getURL("src/content/panel.js")).catch((error) => {
  console.warn("[X Space Downloader] panel failed to load", error);
});
