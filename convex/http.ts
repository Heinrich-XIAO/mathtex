import { httpRouter } from "convex/server";
import { auth } from "./auth";

/** Serves the auth endpoints on the Convex site URL: OAuth hand-off and
 *  callback (…/api/auth/callback/google), session refresh, JWKS. */
const http = httpRouter();
auth.addHttpRoutes(http);

export default http;