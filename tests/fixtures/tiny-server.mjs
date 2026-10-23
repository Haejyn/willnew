// Stand-in dev server for previews: answers every request on $PORT.
import { createServer } from "node:http";
createServer((_req, res) => res.end("ok")).listen(Number(process.env.PORT), "127.0.0.1");
