import { loadCommonConfig } from "./common-config.cjs";

export function readCommonConfig(): string {
  return loadCommonConfig().mode;
}
