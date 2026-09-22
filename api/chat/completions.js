import { proxy } from "../_lib.js";

export const maxDuration = 60;

export default async function handler(req, res) {
  await proxy(req, res, "chat/completions");
}