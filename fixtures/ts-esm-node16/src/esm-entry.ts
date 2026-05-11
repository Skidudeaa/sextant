import { loadModuleConfig } from "./module-config.mjs";

export function readEsmConfig(): string {
  return loadModuleConfig().mode;
}
