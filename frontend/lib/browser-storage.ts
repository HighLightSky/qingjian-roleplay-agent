export type BrowserStorageStatus = {
  usage?: number;
  errors: string[];
};

export async function browserStorageStatus(): Promise<BrowserStorageStatus> {
  const storage = navigator.storage;
  if (!storage || typeof storage.estimate !== "function")
    return { errors: ["当前浏览器环境不支持站点存储用量查询。"] };
  const result: BrowserStorageStatus = { errors: [] };
  try {
    result.usage = (await storage.estimate()).usage;
    if (result.usage === undefined)
      result.errors.push("浏览器未提供本站存储用量。");
  } catch (reason) {
    result.errors.push(`无法查询浏览器存储用量：${String(reason)}`);
  }
  return result;
}
