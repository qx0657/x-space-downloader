import { SpaceError } from "./errors.js";
import { t } from "./i18n.js";

const MEDIA_HOSTS = ["pscp.tv", "twimg.com"];

export function isAllowedMediaUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    return MEDIA_HOSTS.some((host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`));
  } catch {
    return false;
  }
}

export function assertMediaUrl(url) {
  if (!isAllowedMediaUrl(url)) throw new SpaceError("playlist", t("mediaUrlRejected"));
}

export function retryableError(error) {
  if (error?.name === "AbortError" || error?.code === "cancelled") return false;
  if (error instanceof TypeError) return true;
  return error?.code === "timeout" || error?.code === "retry" || error?.code === "network";
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function fetchWithTimeout(url, options = {}, ms = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  let parentAborted = Boolean(options.signal?.aborted);
  const onAbort = () => {
    parentAborted = true;
    controller.abort();
  };
  if (parentAborted) controller.abort();
  options.signal?.addEventListener("abort", onAbort);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError" && !parentAborted) {
      throw new SpaceError("timeout", t("timeout"));
    }
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}
