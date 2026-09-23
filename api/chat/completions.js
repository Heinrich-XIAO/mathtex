import { proxy } from "../_lib.js";

export const config = { runtime: "edge" };

export default async function handler(request) {
  return proxy(request, "chat/completions");
}
