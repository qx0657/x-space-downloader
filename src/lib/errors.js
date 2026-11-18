export class SpaceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SpaceError";
    this.code = code;
  }
}

export function asSpaceError(error) {
  if (error instanceof SpaceError) return error;
  if (error?.name === "AbortError") return new SpaceError("cancelled", "已取消下载");
  return new SpaceError("network", error?.message || "网络请求失败");
}
