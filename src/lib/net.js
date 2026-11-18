import { SpaceError } from "./errors.js";

export async function fetchWithTimeout(url, options = {}, ms = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  let parentAborted = false;
  const onAbort = () => {
    parentAborted = true;
    controller.abort();
  };
  options.signal?.addEventListener("abort", onAbort);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError" && !parentAborted) {
      throw new SpaceError("timeout", "连接超时，请再点一次下载");
    }
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}
