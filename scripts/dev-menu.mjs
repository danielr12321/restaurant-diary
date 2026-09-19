// Runs the find-menu Edge Function on this computer, to try the site locally
// without deploying it:
//   node scripts/dev-menu.mjs            -> http://127.0.0.1:8798/find-menu
// then, in the local site's browser console:
//   localStorage.setItem("diary:dev:menu-url", "http://127.0.0.1:8798/find-menu")
import http from "node:http";
import dns from "node:dns";

const { handle } = await import("../supabase/functions/find-menu/index.ts");
const PORT = Number(process.env.PORT || 8798);

const resolve = async (host) => (await dns.promises.lookup(host, { all: true })).map((a) => a.address);

http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const headers = {};
  for (const name of ["content-type", "authorization", "apikey"]) {
    if (req.headers[name]) headers[name] = req.headers[name];
  }
  const request = new Request("http://127.0.0.1" + req.url, {
    method: req.method,
    headers,
    body: req.method === "POST" ? Buffer.concat(chunks) : undefined,
  });
  const response = await handle(request, resolve, false);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(PORT, "127.0.0.1", () => console.log("find-menu running on http://127.0.0.1:" + PORT + "/find-menu"));
