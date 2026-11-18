import { t } from "./i18n.js";

export class SpaceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SpaceError";
    this.code = code;
  }
}

export function asSpaceError(error) {
  if (error instanceof SpaceError) return error;
  if (error?.name === "AbortError") return new SpaceError("cancelled", t("cancelled"));
  return new SpaceError("network", error?.message || t("networkFailed"));
}
