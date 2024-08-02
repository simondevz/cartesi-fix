import path from "path";

export function getAbsolutePath(...paths) {
  return path.resolve(path.join(".cartesi", ...paths));
}
