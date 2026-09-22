import { proxy } from "../_lib.js";

export default async function handler(req, res) {
  await proxy(req, res, "models");
}