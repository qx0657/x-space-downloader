const HOSTS = new Set(["x.com", "twitter.com", "mobile.x.com", "mobile.twitter.com"]);

export function spaceIdFromText(value) {
  if (!value) return null;
  const text = String(value).trim();
  if (/^[0-9A-Za-z]{13,}$/.test(text)) return text;
  try {
    const withProtocol = /^https?:\/\//i.test(text) ? text : `https://${text}`;
    const url = new URL(withProtocol);
    const host = url.hostname.replace(/^www\./, "");
    if (!HOSTS.has(host)) return null;
    const match = url.pathname.match(/\/i\/spaces\/([0-9A-Za-z]{13,})/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

export function spacePageUrl(spaceId) {
  return `https://x.com/i/spaces/${spaceId}`;
}
