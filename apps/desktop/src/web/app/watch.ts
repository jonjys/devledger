// Imported first by the web app, so the request counter is running before any
// other module is even evaluated.
import { install } from "./netwatch";

install();
