// Restaurant Diary: find a restaurant's menu on its own website.
//
// Runs as the Supabase Edge Function "find-menu", because a web page can't read
// other websites itself. Deploy: Supabase dashboard -> Edge Functions -> Deploy a
// new function -> Via Editor, name it find-menu, replace the sample with this whole
// file, then Deploy.
//
// Works in two passes: read the homepage for a link that looks like the menu (text
// or address containing "menu", "תפריט", "carte", ...), then read that page for
// dishes. Dishes come from schema.org MenuItem data when the site publishes it,
// otherwise from lines that carry a price ("Shakshuka 58 ₪").
//
// This is best-effort by nature. Menus that are PDFs, images, Instagram posts or
// built entirely in JavaScript can be linked but not read, and the result says so.

const USER_AGENT = "Mozilla/5.0 (compatible; RestaurantDiary/1.0; personal use)";
const TIMEOUT_MS = 10_000;
const TIME_BUDGET_MS = 30_000; // for one whole search, however many pages it opens
const MAX_BYTES = 3 * 1024 * 1024;
const MAX_ITEMS = 150;
// Saved with each result, so menus found by an older, weaker search get re-checked.
export const FINDER_VERSION = 2;

const MENU_WORDS = ["menu", "תפריט", "carte", "speisekarte", "menù", "carta"];
const FOOD_WORDS = ["food", "dishes", "אוכל", "מנות", "our kitchen"];
const NAV_NOISE = ["main menu", "toggle menu", "close menu", "open menu", "menu toggle",
  "skip to", "mobile menu"];
const COMMON_MENU_PATHS = ["/menu", "/menus", "/" + encodeURIComponent("תפריט"), "/our-menu"];

// Restaurants often list one of these as their "website". They need an app or a
// login, so they're never read: ordering pages are linked as the menu, profile and
// booking pages are explained. A null has_menu means "depends on the page".
const PLATFORMS: [string, string, boolean | null][] = [
  ["instagram.com", "Instagram page", false],
  ["facebook.com", "Facebook page", false],
  ["tiktok.com", "TikTok page", false],
  ["linktr.ee", "Linktree page", false],
  ["ontopo.com", "Ontopo booking page", false],
  ["ontopo.co.il", "Ontopo booking page", false],
  ["google.com", "Google page", false],
  ["goo.gl", "Google link", false],
  ["wolt.com", "Wolt ordering page", true],
  ["10bis.co.il", "10bis ordering page", true],
  ["mishloha.co.il", "Mishloha ordering page", true],
  ["beecommcloud.com", "online-ordering page", true],
  ["tabitisrael.co.il", "Tabit page", null],
];

// Hosts that show a PDF as a page-turning "flip-book".
const DOC_VIEWERS = ["heyzine.com", "issuu.com", "flipsnack.com", "yumpu.com", "calameo.com",
  "fliphtml5.com", "anyflip.com", "publuu.com"];
const DOC_GOOGLE = ["drive.google.com/file", "docs.google.com/viewer", "docs.google.com/document"];
const NOT_A_MENU_DOC_RE = /נגישות|accessib|terms|privacy|תקנון|מדיניות|cookie/i;

const BLOCK_TAGS = new Set(["p", "div", "li", "tr", "td", "th", "h1", "h2", "h3", "h4", "h5", "h6",
  "section", "article", "header", "footer", "ul", "ol", "table", "dt", "dd", "br", "figcaption",
  "blockquote", "main", "nav", "aside"]);
const SKIP_TAGS = new Set(["script", "style", "noscript", "svg", "template"]);
// Their content is text, never tags.
const RAW_TEXT_TAGS = new Set(["script", "style"]);

// Letter guards stop "NIS"/"ILS" matching inside words like "tennis" or "details".
const CURRENCY = String.raw`(?:₪|(?<![A-Za-z])(?:NIS|ILS)(?![A-Za-z])|ש["״']?ח|€|\$|£)`;
const AMOUNT = String.raw`\d{1,4}(?:[.,]\d{1,2})?`;
const PRICE_RE = new RegExp(String.raw`${CURRENCY}\s?${AMOUNT}|${AMOUNT}\s?${CURRENCY}`, "i");
const BARE_PRICE_RE = /^(.{3,70}?)\s*(?:\.{2,}|…+|[-–—|:])?\s*(\d{2,3})$/;
// A price alone on its line: "58", "₪58", "58 ₪", "28 ליח'" (per piece), "64 למנה".
const STANDALONE_PRICE_RE =
  /^(?:₪\s?)?(\d{2,3}(?:[.,]\d{1,2})?)\s?(?:₪|ש["״']?ח|nis|ליח["״'׳’]?|ל?יחידה|למנה|לאדם)?$/i;
const LETTERS_RE = /[A-Za-z֐-׿À-ɏ]{2,}/;
// Word edges that also count Hebrew letters as part of a word.
const B = String.raw`(?<![\p{L}\p{N}_])`;
const E = String.raw`(?![\p{L}\p{N}_])`;
const NOT_A_DISH_RE = new RegExp(
  String.raw`\d{1,2}[:.]\d{2}|\*\d|${B}tel${E}|phone|טל|טלפון|${B}(?:sun|mon|tue|wed|thu|fri|sat)` +
  String.raw`|day${E}|יום|ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת|רחוב|street|${B}st${E}`,
  "iu",
);

/** A failure worth showing to the user as-is. */
export class MenuError extends Error {}

type Link = { url: string; label: string };
type Dish = { name: string; price: string; desc: string };
type Result = {
  url: string; links: Link[]; items: Dish[]; kind: string; finder: number;
  checked_at: string; message: string; platform?: string;
};
type Resolver = (host: string) => Promise<string[]>;
type Context = { resolve: Resolver; deadline: number };

// ---------- fetching, only from public addresses ----------

function ipv4Private(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !(n >= 0 && n <= 255))) return true;
  const [a, b, c] = p;
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113);
}

function ipPrivate(ip: string): boolean {
  const addr = ip.toLowerCase().split("%")[0];
  if (!addr.includes(":")) return ipv4Private(addr);
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (mapped) return ipv4Private(mapped[1]);
  return addr === "::" || addr === "::1" || /^f[cd]/.test(addr) || /^fe[89ab]/.test(addr) ||
    addr.startsWith("ff") || addr.startsWith("2001:db8");
}

function isIpLiteral(host: string): boolean {
  return /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":");
}

/**
 * Refuse anything that is not a public web address. Website fields come from
 * maps data and pasted links, so a hostile or mistaken value could point at a
 * private service.
 */
async function checkHost(url: string, resolve: Resolver): Promise<void> {
  let parts: URL;
  try {
    parts = new URL(url);
  } catch {
    throw new MenuError("That web address isn't valid.");
  }
  if (!["http:", "https:"].includes(parts.protocol) || !parts.hostname) {
    throw new MenuError("Only ordinary web addresses (http or https) can be checked.");
  }
  const host = parts.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || /\.(localhost|local|internal|lan|home)$/.test(host)) {
    throw new MenuError("That address points inside your own network, so it was not opened.");
  }
  const ips = isIpLiteral(host) ? [host] : await resolve(host);
  if (ips.some(ipPrivate)) {
    throw new MenuError("That address points inside your own network, so it was not opened.");
  }
}

/** Percent-encode an address so Hebrew paths ("/תפריט") can be requested. */
function asciiUrl(url: string): string {
  try {
    const parsed = new URL(url.trim());
    parsed.hash = "";
    return parsed.href;
  } catch {
    throw new MenuError("That web address isn't valid.");
  }
}

async function readLimited(response: Response, max: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
    if (total >= max) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  const out = new Uint8Array(Math.min(total, max));
  let offset = 0;
  for (const chunk of chunks) {
    const part = chunk.subarray(0, Math.min(chunk.length, out.length - offset));
    out.set(part, offset);
    offset += part.length;
    if (offset >= out.length) break;
  }
  return out;
}

type Fetched = { finalUrl: string; contentType: string; body: Uint8Array };

async function fetchPage(url: string, ctx: Context): Promise<Fetched> {
  let current = asciiUrl(url);
  for (let hop = 0; hop < 8; hop += 1) {
    await checkHost(current, ctx.resolve);
    let response: Response;
    try {
      response = await fetch(current, {
        redirect: "manual",
        headers: {
          "User-Agent": USER_AGENT,
          "Accept": "text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.5",
          "Accept-Language": "he,en;q=0.8",
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      const name = (err as Error)?.name || "";
      if (name === "TimeoutError" || name === "AbortError") {
        throw new MenuError("The website took too long to answer.");
      }
      const text = String((err as Error)?.message || err);
      if (/dns|lookup|ENOTFOUND|getaddrinfo|resolve/i.test(text)) {
        throw new MenuError("Could not find the website " + new URL(current).hostname + ".");
      }
      // Broken TLS, dropped connections, malformed replies: all just "couldn't open".
      throw new MenuError("Could not open the website (" + (name || "network error") + ").");
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => {});
      if (!location) throw new MenuError("The website answered with an error (" + response.status + ").");
      current = asciiUrl(new URL(location, current).href);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new MenuError("The website answered with an error (" + response.status + ").");
    }
    let body: Uint8Array;
    try {
      body = await readLimited(response, MAX_BYTES);
    } catch {
      throw new MenuError("The website took too long to answer.");
    }
    return { finalUrl: current, contentType: response.headers.get("content-type") || "", body };
  }
  throw new MenuError("The website redirected too many times.");
}

function decodeBody(body: Uint8Array, contentType: string): string {
  let charset = (/charset=([\w-]+)/i.exec(contentType || "") || [])[1];
  if (!charset) {
    const head = new TextDecoder("latin1").decode(body.subarray(0, 4096));
    charset = (/<meta[^>]+charset=["']?([\w-]+)/i.exec(head) || [])[1] || "utf-8";
  }
  try {
    return new TextDecoder(charset).decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
}

// ---------- reading a page ----------

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—",
  hellip: "…", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", sbquo: "‚", bdquo: "„",
  laquo: "«", raquo: "»", middot: "·", bull: "•", shy: "­", euro: "€", pound: "£",
  cent: "¢", yen: "¥", copy: "©", reg: "®", trade: "™", times: "×", divide: "÷", deg: "°",
  frac12: "½", frac14: "¼", frac34: "¾", eacute: "é", egrave: "è", ecirc: "ê", agrave: "à",
  aacute: "á", acirc: "â", auml: "ä", ouml: "ö", uuml: "ü", oacute: "ó", iacute: "í",
  uacute: "ú", ntilde: "ñ", ccedil: "ç", szlig: "ß", zwj: "‍", zwnj: "‌",
  lrm: "‎", rlm: "‏", ensp: " ", emsp: " ", thinsp: " ",
};

function unescapeHtml(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);?/gi, (whole, ref: string) => {
    if (ref[0] === "#") {
      const code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      if (!(code > 0 && code <= 0x10ffff)) return "�";
      try {
        return String.fromCodePoint(code);
      } catch {
        return "�";
      }
    }
    const named = ENTITIES[ref] ?? ENTITIES[ref.toLowerCase()];
    return named === undefined ? whole : named;
  });
}

type Page = { links: [string, string][]; frames: string[]; jsonld: string[]; lines: string[] };

const TAG_RE =
  /<!--[\s\S]*?(?:-->|$)|<![^>]*>|<\?[^>]*>|<\/([a-zA-Z][^\s/>]*)[^>]*>|<([a-zA-Z][^\s/>]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
const ATTR_RE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

function squash(text: string): string {
  return text.split(/\s+/).filter(Boolean).join(" ");
}

/** Text lines, links, frames and JSON-LD blocks of an HTML page. */
export function parsePage(html: string): Page {
  const page: Page = { links: [], frames: [], jsonld: [], lines: [] };
  let text: string[] = [];
  let anchor: [string, string[], string] | null = null;
  let jsonld: string[] | null = null;
  let skip = 0;

  const flush = () => {
    const line = squash(text.join(""));
    if (line) page.lines.push(line);
    text = [];
  };
  const data = (chunk: string) => {
    if (jsonld !== null) {
      jsonld.push(chunk);
      return;
    }
    if (skip) return;
    if (anchor !== null) anchor[1].push(chunk);
    text.push(chunk);
  };
  const start = (tag: string, attrs: Record<string, string>) => {
    if (tag === "script" && (attrs.type || "").toLowerCase() === "application/ld+json") {
      jsonld = [];
      return;
    }
    if (SKIP_TAGS.has(tag)) {
      skip += 1;
      return;
    }
    if (BLOCK_TAGS.has(tag)) flush();
    if (tag === "a") anchor = [attrs.href || "", [], attrs["aria-label"] || attrs.title || ""];
    if (tag === "iframe" || tag === "embed" || tag === "object") {
      const source = attrs.src || attrs.data;
      if (source) page.frames.push(source);
    }
  };
  const end = (tag: string) => {
    if (tag === "script" && jsonld !== null) {
      page.jsonld.push(jsonld.join(""));
      jsonld = null;
      return;
    }
    if (SKIP_TAGS.has(tag)) {
      skip = Math.max(0, skip - 1);
      return;
    }
    if (tag === "a" && anchor !== null) {
      const [href, parts, label] = anchor;
      page.links.push([href, squash(parts.join("")) || label]);
      anchor = null;
    }
    if (BLOCK_TAGS.has(tag)) flush();
  };

  let pos = 0;
  TAG_RE.lastIndex = 0;
  for (;;) {
    const match = TAG_RE.exec(html);
    if (!match) break;
    if (match.index > pos) data(unescapeHtml(html.slice(pos, match.index)));
    pos = TAG_RE.lastIndex;
    if (match[1]) {
      end(match[1].toLowerCase());
      continue;
    }
    if (!match[2]) continue; // comment, doctype, processing instruction
    const tag = match[2].toLowerCase();
    const rawAttrs = match[3] || "";
    const attrs: Record<string, string> = {};
    ATTR_RE.lastIndex = 0;
    for (let a = ATTR_RE.exec(rawAttrs); a; a = ATTR_RE.exec(rawAttrs)) {
      const key = a[1].toLowerCase();
      if (!(key in attrs)) attrs[key] = unescapeHtml(a[2] ?? a[3] ?? a[4] ?? "");
    }
    const selfClosing = /\/\s*$/.test(rawAttrs);
    start(tag, attrs);
    if (selfClosing) {
      end(tag);
      continue;
    }
    if (RAW_TEXT_TAGS.has(tag)) {
      const close = html.slice(pos).search(new RegExp("</" + tag + "\\s*>", "i"));
      const stop = close < 0 ? html.length : pos + close;
      if (stop > pos) data(html.slice(pos, stop));
      end(tag);
      const closing = html.slice(stop).match(new RegExp("^</" + tag + "\\s*>", "i"));
      pos = stop + (closing ? closing[0].length : 0);
      TAG_RE.lastIndex = pos;
    }
  }
  if (pos < html.length) data(unescapeHtml(html.slice(pos)));
  flush();
  return page;
}

function parse(body: Uint8Array, contentType: string): Page {
  return parsePage(decodeBody(body, contentType));
}

// ---------- what kind of address is this? ----------

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

function unquote(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function isPdf(url: string, contentType: string): boolean {
  return (contentType || "").toLowerCase().includes("pdf") || pathOf(url).toLowerCase().endsWith(".pdf");
}

function hostMatches(host: string, domains: string[]): boolean {
  return domains.some((d) => host === d || host.endsWith("." + d));
}

/** [name, has_menu] when the address is a profile, booking or ordering page. */
function platformOf(url: string): [string, boolean] | null {
  let parts: URL;
  try {
    parts = new URL(url);
  } catch {
    return null;
  }
  const host = parts.hostname.toLowerCase();
  for (const [domain, name, hasMenu] of PLATFORMS) {
    if (hostMatches(host, [domain])) {
      if (hasMenu === null) {
        // Tabit: ordering pages have a menu, the rest are bookings
        const ordering = (parts.pathname + "?" + parts.search.replace(/^\?/, "")).toLowerCase().includes("order");
        return [ordering ? "Tabit ordering page" : "Tabit booking page", ordering];
      }
      return [name, hasMenu];
    }
  }
  return null;
}

function isDocument(url: string): boolean {
  const lower = unquote(url).toLowerCase();
  return pathOf(url).toLowerCase().endsWith(".pdf") || hostMatches(hostOf(url), DOC_VIEWERS) ||
    DOC_GOOGLE.some((marker) => lower.includes(marker));
}

function docKind(url: string): string {
  return pathOf(url).toLowerCase().endsWith(".pdf") ? "pdf" : "document";
}

function menuish(text: string): boolean {
  const lower = text.toLowerCase();
  return MENU_WORDS.some((word) => lower.includes(word)) || lower.includes("tafrit");
}

function absoluteLinks(page: Page, baseUrl: string): [string, string][] {
  const out: [string, string][] = [];
  const all: [string, string][] = [...page.links, ...page.frames.map((src): [string, string] => [src, ""])];
  for (const [href, text] of all) {
    const raw = (href || "").trim();
    if (!raw || /^(#|javascript:|mailto:|tel:|whatsapp:)/i.test(raw)) continue;
    let absolute: string;
    try {
      absolute = new URL(raw, baseUrl).href.split("#")[0];
    } catch {
      continue;
    }
    if (/^https?:\/\//.test(absolute)) out.push([absolute, text.trim()]);
  }
  return out;
}

/** PDF and flip-book menus linked or embedded on a page, menu-looking ones first. */
function documentsOf(page: Page, baseUrl: string, menuOnly: boolean): Link[] {
  const found = new Map<string, [number, string]>();
  for (const [url, text] of absoluteLinks(page, baseUrl)) {
    if (!isDocument(url)) continue;
    const both = text + " " + unquote(url);
    const looksLikeMenu = menuish(both);
    if (menuOnly && !looksLikeMenu) continue;
    if (!looksLikeMenu && NOT_A_MENU_DOC_RE.test(both)) continue;
    const score = looksLikeMenu ? 2 : 1;
    const current = found.get(url);
    if (!current || current[0] < score) {
      const file = unquote(pathOf(url).split("/").pop() || "").replace(/\.[^.]*$/, "");
      found.set(url, [score, text.slice(0, 80) || file.slice(0, 80) || "Menu"]);
    }
  }
  return [...found.entries()]
    .sort((a, b) => b[1][0] - a[1][0])
    .map(([url, [, label]]) => ({ url, label }));
}

function rankLinks(page: Page, baseUrl: string): Link[] {
  const baseHost = hostOf(baseUrl);
  const ranked = new Map<string, [number, string]>();
  for (const [absolute, text] of absoluteLinks(page, baseUrl)) {
    if (absolute.replace(/\/+$/, "") === baseUrl.replace(/\/+$/, "")) continue;
    const label = text.toLowerCase();
    const path = unquote(absolute).toLowerCase();
    if (NAV_NOISE.some((noise) => label.includes(noise))) continue;

    let score = 0;
    if (MENU_WORDS.some((word) => label.includes(word))) score += 10;
    if (MENU_WORDS.some((word) => path.includes(word)) || path.includes("tafrit")) score += 6;
    if (FOOD_WORDS.some((word) => label.includes(word))) score += 3;
    if (!score) continue;
    if (isDocument(absolute)) score += 2;
    if (hostOf(absolute) === baseHost) score += 1;
    if (platformOf(absolute)) score -= 4;

    const current = ranked.get(absolute);
    if (!current || score > current[0]) ranked.set(absolute, [score, text.slice(0, 80) || "Menu"]);
  }
  return [...ranked.entries()]
    .sort((a, b) => b[1][0] - a[1][0])
    .map(([url, [, label]]) => ({ url, label }));
}

// ---------- reading dishes ----------

function walkJsonld(node: unknown, items: Dish[], menus: string[]): void {
  if (Array.isArray(node)) {
    for (const child of node) walkJsonld(child, items, menus);
    return;
  }
  if (!node || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;

  const types = Array.isArray(obj["@type"]) ? obj["@type"] as unknown[] : [obj["@type"]];
  if (types.includes("MenuItem") && obj.name) {
    const offers = obj.offers;
    const offer = (Array.isArray(offers) ? offers[0] : offers) as Record<string, unknown> | undefined;
    let price = "";
    if (offer && typeof offer === "object" && offer.price !== undefined && offer.price !== null && offer.price !== "") {
      price = (String(offer.price) + " " + String(offer.priceCurrency || "")).trim();
    }
    const desc = typeof obj.description === "string" ? obj.description : "";
    items.push({ name: String(obj.name).trim(), price, desc: desc.slice(0, 160) });
  }

  for (const key of ["hasMenu", "menu"]) {
    const value = obj[key];
    if (typeof value === "string" && value.startsWith("http")) menus.push(value);
    else if (value && typeof value === "object" && !Array.isArray(value) &&
      typeof (value as Record<string, unknown>).url === "string") {
      menus.push((value as Record<string, string>).url);
    }
  }

  for (const value of Object.values(obj)) {
    if (value && typeof value === "object") walkJsonld(value, items, menus);
  }
}

function jsonldMenu(page: Page): [Dish[], string[]] {
  const items: Dish[] = [];
  const menus: string[] = [];
  for (const block of page.jsonld) {
    try {
      walkJsonld(JSON.parse(block), items, menus);
    } catch {
      continue;
    }
  }
  return [items, menus];
}

function stripChars(text: string, chars: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && chars.includes(text[start])) start += 1;
  while (end > start && chars.includes(text[end - 1])) end -= 1;
  return text.slice(start, end);
}

function usableName(text: string): boolean {
  return text.length <= 70 && LETTERS_RE.test(text) && !NOT_A_DISH_RE.test(text) &&
    !STANDALONE_PRICE_RE.test(text);
}

function amountOf(text: string): number {
  return parseFloat(text.replace(",", "."));
}

/** Lines like "Shakshuka 58 ₪", or dish (and description) lines above a "₪58" line. */
function currencyPrices(lines: string[]): Dish[] {
  const isText = (line: string) =>
    !!line && line.length <= 140 && LETTERS_RE.test(line) && !PRICE_RE.test(line);

  const items: Dish[] = [];
  lines.forEach((line, index) => {
    if (line.length > 140) return;
    const match = PRICE_RE.exec(line);
    if (!match) return;
    const amount = /\d+(?:[.,]\d+)?/.exec(match[0]);
    if (!amount || !(amountOf(amount[0]) > 0)) return; // "₪0.00" is a button or a free add-on
    let name = line.slice(0, match.index) + " " + line.slice(match.index + match[0].length);
    name = squash(stripChars(name.replace(/\.{2,}|…+/g, " "), " .-–—|:·•\t"));
    let desc = "";
    if (!LETTERS_RE.test(name)) {
      // The price has its own line; the dish is above it. When the line right above
      // reads like a description, the name is the line before that.
      const above = index >= 1 ? lines[index - 1] : "";
      const above2 = index >= 2 ? lines[index - 2] : "";
      if (!isText(above)) return;
      if ((above.includes(",") || above.length > 40) && isText(above2) && above2.length <= 40) {
        name = above2;
        desc = above;
      } else {
        name = above;
      }
    }
    if (name && name.length <= 90 && LETTERS_RE.test(name)) {
      items.push({ name, price: match[0].trim(), desc: desc.slice(0, 160) });
    }
  });
  return items;
}

/** "Seared fish, pomelo salad, fennel" -> ["Seared fish", "pomelo salad, fennel"]. */
function splitDish(text: string): [string, string] {
  if (text.length <= 50 || !text.includes(",")) return [text, ""];
  const cut = text.indexOf(",");
  return [text.slice(0, cut).trim(), text.slice(cut + 1).trim()];
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
}

/**
 * Menus that print the price alone on its own line, with no ₪ sign.
 * Three layouts turn up, and each page is checked to see which it uses:
 *   dish / 58 / description      (the description is the longer neighbour)
 *   dish / description / 58
 *   heading / 58 / dish, description, ...   (prices alternate with long lines)
 */
function standalonePrices(lines: string[]): Dish[] {
  const prices: number[] = [];
  lines.forEach((line, i) => {
    const match = STANDALONE_PRICE_RE.exec(line.trim());
    if (match) {
      const value = amountOf(match[1]);
      if (value >= 10 && value <= 999) prices.push(i);
    }
  });
  if (prices.length < 5) return [];

  const before = median(prices.filter((i) => i >= 1).map((i) => lines[i - 1].length));
  const after = median(prices.filter((i) => i + 1 < lines.length).map((i) => lines[i + 1].length));
  const gap = median(prices.slice(1).map((b, k) => b - prices[k]));
  const first = prices[0];
  const priceFirst = gap <= 2 && Math.min(before, after) > 45 && first >= 1 && lines[first - 1].length <= 25;
  const nameFirst = !priceFirst && (gap <= 2 || before <= after);

  const taken = new Set(prices);
  const items: Dish[] = [];
  for (const i of prices) {
    if (priceFirst) {
      const j = i + 1;
      if (j >= lines.length || taken.has(j)) continue;
      const [name, desc] = splitDish(lines[j]);
      if (!usableName(name)) continue;
      items.push({ name, price: lines[i].trim(), desc: desc.slice(0, 160) });
      taken.add(j);
      continue;
    }
    let j: number;
    let k: number;
    let descOk: boolean;
    if (nameFirst) {
      j = i - 1;
      k = i + 1;
      // The line after is a description only if the next price isn't right behind it.
      descOk = k < lines.length && !taken.has(k) && !taken.has(k + 1);
    } else {
      j = i - 2;
      k = i - 1;
      descOk = true;
      if (j < 0 || taken.has(j)) { // this dish has no description
        j = i - 1;
        descOk = false;
      }
    }
    if (j < 0 || taken.has(j) || !usableName(lines[j])) continue;
    let desc = descOk && k >= 0 && k < lines.length && k !== j ? lines[k] : "";
    if (desc && (!LETTERS_RE.test(desc) || desc.length > 160 || taken.has(k))) desc = "";
    items.push({ name: lines[j], price: lines[i].trim(), desc });
    taken.add(j);
  }
  return items.length >= 5 ? items : [];
}

// Many Israeli menus print bare numbers ("שקשוקה 52"). Branch pages print phones
// ("Tel *3067") and hours ("Sun - 12.00-22.30") the same way, so those shapes are
// rejected and the rule only applies to a page full of distinct lines.
function barePrices(lines: string[]): Dish[] {
  const bare: Dish[] = [];
  for (const line of lines) {
    const match = BARE_PRICE_RE.exec(line);
    if (!match) continue;
    const name = stripChars(match[1].trim(), " .-–—|:");
    const amount = match[2];
    const value = parseInt(amount, 10);
    if (!LETTERS_RE.test(name) || amount.startsWith("0") || value < 10 || value > 999 ||
      NOT_A_DISH_RE.test(line)) continue;
    bare.push({ name, price: amount, desc: "" });
  }
  return dedupe(bare);
}

/** The most convincing reading of a page's dishes, or [] if none is. */
function priceLines(lines: string[]): Dish[] {
  const readings: [Dish[], number][] = [
    [currencyPrices(lines), 3], [standalonePrices(lines), 5], [barePrices(lines), 6],
  ];
  let best: Dish[] = [];
  for (const [items, needed] of readings) {
    if (items.length >= needed && items.length > best.length) best = items;
  }
  return best;
}

function dedupe(items: Dish[]): Dish[] {
  const seen = new Set<string>();
  const out: Dish[] = [];
  for (const item of items) {
    const key = item.name.toLowerCase() + " " + item.price;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out.slice(0, MAX_ITEMS);
}

// ---------- finding the menu ----------

type MenuPage = { finalUrl: string; items: Dish[]; kind: string; documents: Link[] };

/** A page believed to be the menu: its dishes, or what kind of menu it is. */
async function readMenuPage(url: string, ctx: Context): Promise<MenuPage> {
  const { finalUrl, contentType, body } = await fetchPage(url, ctx);
  if (isPdf(finalUrl, contentType)) return { finalUrl, items: [], kind: "pdf", documents: [] };
  const page = parse(body, contentType);
  let [items] = jsonldMenu(page);
  if (!items.length) items = priceLines(page.lines);
  const documents = items.length ? [] : documentsOf(page, finalUrl, false);
  return { finalUrl, items, kind: "page", documents };
}

function useDocuments(result: Result, documents: Link[]): void {
  result.url = documents[0].url;
  result.kind = docKind(documents[0].url);
  result.links = documents.slice(0, 6);
}

/**
 * Read candidate menu pages until one gives dishes or a PDF/flip-book.
 *
 * `keepPage` records the first page that opened even if nothing could be read
 * from it: right for real links, wrong for guessed addresses like /menu that many
 * sites answer with their homepage.
 */
async function tryPages(candidates: Link[], result: Result, ctx: Context, keepPage = true): Promise<boolean> {
  for (const link of candidates.slice(0, 3)) {
    if (Date.now() > ctx.deadline) return false;
    const url = link.url;
    const platform = platformOf(url);
    if (platform && !platform[1]) continue;
    let read: MenuPage;
    try {
      read = await readMenuPage(url, ctx);
    } catch (err) {
      if (!(err instanceof MenuError)) throw err;
      if (!platform) continue;
      read = { finalUrl: url, items: [], kind: "", documents: [] };
    }
    if (platform && !read.items.length) {
      // Ordering pages mostly draw their menu with JavaScript: link it instead.
      if (!result.url) Object.assign(result, { url, kind: "platform", platform: platform[0] });
      continue;
    }
    if (read.items.length) {
      Object.assign(result, { url: read.finalUrl, items: dedupe(read.items), kind: "page" });
      return true;
    }
    if (read.kind === "pdf") {
      Object.assign(result, { url: read.finalUrl, kind: "pdf" });
      return true;
    }
    if (read.documents.length) {
      useDocuments(result, read.documents);
      return true;
    }
    if (keepPage && (result.kind === "" || result.kind === "platform")) {
      Object.assign(result, { url: read.finalUrl, kind: "page" });
    }
  }
  return false;
}

const LOC_RE = /<loc>\s*([^<\s]+)\s*<\/loc>/g;

function locations(body: Uint8Array): string[] {
  const text = new TextDecoder("utf-8").decode(body);
  return [...text.matchAll(LOC_RE)].map((m) => m[1]);
}

/** Menu pages the homepage doesn't link to: from the sitemap, else common paths. */
async function guessedPages(siteUrl: string, ctx: Context): Promise<[Link[], boolean]> {
  const root = new URL(siteUrl).origin;
  let found: Link[] = [];
  for (const path of ["/sitemap.xml", "/wp-sitemap.xml", "/sitemap_index.xml"]) {
    if (Date.now() > ctx.deadline) break;
    let body: Uint8Array;
    try {
      ({ body } = await fetchPage(root + path, ctx));
    } catch (err) {
      if (err instanceof MenuError) continue;
      throw err;
    }
    const locs = locations(body);
    let pages = locs.filter((loc) => !loc.toLowerCase().endsWith(".xml"));
    for (const nested of locs.filter((loc) => loc.toLowerCase().endsWith(".xml")).slice(0, 3)) {
      if (Date.now() > ctx.deadline) break;
      try {
        pages = pages.concat(locations((await fetchPage(nested, ctx)).body));
      } catch (err) {
        if (err instanceof MenuError) continue;
        throw err;
      }
    }
    found = pages
      .filter((page) => menuish(unquote(page)) && !page.toLowerCase().endsWith(".xml"))
      .map((page) => ({ url: page, label: "Menu" }));
    if (pages.length) break;
  }
  if (found.length) return [found, true];
  return [COMMON_MENU_PATHS.map((path) => ({ url: root + path, label: "Menu" })), false];
}

/** Find the menu from a homepage and read dishes from wherever it leads. */
async function searchHomepage(website: string, result: Result, ctx: Context): Promise<void> {
  const { finalUrl, contentType, body } = await fetchPage(website, ctx);
  if (isPdf(finalUrl, contentType)) {
    Object.assign(result, { url: finalUrl, kind: "pdf" });
    return;
  }

  const homepage = parse(body, contentType);
  const [items, jsonldMenus] = jsonldMenu(homepage);
  let links: Link[] = [];
  for (const menu of jsonldMenus) {
    try {
      links.push({ url: new URL(menu, finalUrl).href, label: "Menu" });
    } catch {
      /* not an address */
    }
  }
  const known = new Set(links.map((link) => link.url));
  links = links.concat(rankLinks(homepage, finalUrl).filter((link) => !known.has(link.url)));
  if (links.length) result.links = links.slice(0, 6);

  if (items.length) {
    Object.assign(result, { url: links.length ? links[0].url : finalUrl, items: dedupe(items), kind: "page" });
    return;
  }
  if (links.length && await tryPages(links, result, ctx)) return;
  if (result.url) return;

  const documents = documentsOf(homepage, finalUrl, true);
  if (documents.length) {
    useDocuments(result, documents);
    return;
  }
  // Single-page sites often print the menu straight on the homepage.
  const pageItems = priceLines(homepage.lines);
  if (pageItems.length >= 5) {
    Object.assign(result, { url: finalUrl, items: dedupe(pageItems), kind: "page" });
    return;
  }

  const [guesses, fromSitemap] = await guessedPages(finalUrl, ctx);
  await tryPages(guesses, result, ctx, fromSitemap);
}

function finish(result: Result): Result {
  const count = result.items.length;
  const where = result.platform || "another site";
  if (result.kind === "pdf") {
    result.message = "The menu is a PDF. Open it to read it — dishes can't be copied out of a PDF automatically.";
  } else if (result.kind === "document") {
    result.message = "The menu is an embedded document (a flip-book). Open it to read it — dishes can't be " +
      "copied out of it automatically.";
  } else if (result.kind === "platform") {
    result.message = "The menu is on the restaurant's " + where + ", which can only be viewed there — open it " +
      "to see the dishes and prices.";
  } else if (result.kind === "profile") {
    result.message = "This restaurant's listed website is its " + where + ", which has no menu to read. If you " +
      "know the menu's link, paste it below.";
  } else if (result.url && count) {
    result.message = "Found " + count + " dish" + (count === 1 ? "" : "es") + ". Automatic reading can miss or " +
      "mislabel some — check against the real menu.";
  } else if (result.url) {
    result.message = "Found a menu page, but couldn't read dishes from it (it's probably built with images or " +
      "JavaScript). Open it to see the menu.";
  } else {
    result.message = "Couldn't find a menu on the website — it may only show one inside buttons or images. If " +
      "you have the link, paste it below.";
  }
  return result;
}

/**
 * Profile and booking pages are explained; ordering pages are read if possible
 * (Wolt, for one, sends its menu with prices in the page) and linked otherwise.
 */
async function usePlatform(result: Result, url: string, platform: [string, boolean], ctx: Context): Promise<void> {
  const [name, hasMenu] = platform;
  result.platform = name;
  if (!hasMenu) {
    result.kind = "profile";
    return;
  }
  let items: Dish[] = [];
  try {
    items = (await readMenuPage(url, ctx)).items;
  } catch (err) {
    if (!(err instanceof MenuError)) throw err;
  }
  if (items.length) Object.assign(result, { url, items: dedupe(items), kind: "page" });
  else Object.assign(result, { url, kind: "platform", links: [{ url, label: name }] });
}

/** Look for a menu, starting from a pasted link when there is one. */
export async function findMenu(website: string, menuUrl: string, resolve: Resolver): Promise<Result> {
  const ctx: Context = { resolve, deadline: Date.now() + TIME_BUDGET_MS };
  const result: Result = {
    url: "", links: [], items: [], kind: "", finder: FINDER_VERSION,
    checked_at: new Date().toISOString(), message: "",
  };

  if (menuUrl) {
    const platform = platformOf(menuUrl);
    if (platform) {
      await usePlatform(result, menuUrl, platform, ctx);
      return finish(result);
    }
    const read = await readMenuPage(menuUrl, ctx);
    result.links = [{ url: read.finalUrl, label: "Menu" }];
    if (read.items.length) {
      Object.assign(result, { url: read.finalUrl, items: dedupe(read.items), kind: "page" });
      return finish(result);
    }
    if (read.kind === "pdf") {
      Object.assign(result, { url: read.finalUrl, kind: "pdf" });
      return finish(result);
    }
    if (read.documents.length) {
      useDocuments(result, read.documents);
      return finish(result);
    }
    // Pasted by hand, so worth keeping even if unreadable. It may just be the
    // homepage, though, so still look for the menu from there.
    Object.assign(result, { url: read.finalUrl, kind: "page" });
    website = read.finalUrl;
  }

  if (!website) throw new MenuError("There is no website on record for this restaurant.");

  const platform = platformOf(website);
  if (platform) {
    await usePlatform(result, website, platform, ctx);
    return finish(result);
  }

  await searchHomepage(website, result, ctx);
  return finish(result);
}

// ---------- the Edge Function ----------

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });
}

// deno-lint-ignore no-explicit-any
const runtime = (globalThis as any).Deno;

// If DNS lookups aren't available, fetch still refuses unknown hosts, and the
// address checks above still cover literal IPs and local names.
async function denoResolve(host: string): Promise<string[]> {
  const found: string[] = [];
  for (const type of ["A", "AAAA"]) {
    try {
      found.push(...await runtime.resolveDns(host, type));
    } catch {
      /* no records of this type, or lookups not allowed */
    }
  }
  return found;
}

/** Only people signed in to the diary (anonymous sign-ins count) may use this. */
async function signedIn(request: Request): Promise<boolean> {
  const base = runtime?.env?.get("SUPABASE_URL");
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const apikey = request.headers.get("apikey") || runtime?.env?.get("SUPABASE_ANON_KEY") || "";
  if (!base || !token || token === apikey) return false;
  try {
    const response = await fetch(base + "/auth/v1/user", {
      headers: { Authorization: "Bearer " + token, apikey },
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function handle(request: Request, resolve: Resolver = denoResolve, checkUser = true): Promise<Response> {
  if (request.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (request.method !== "POST") return reply({ error: "Use POST." }, 405);
  if (checkUser && !await signedIn(request)) {
    return reply({ error: "The diary isn't signed in. Reload the page and try again." }, 401);
  }

  let payload: Record<string, unknown>;
  try {
    payload = await request.json();
  } catch {
    return reply({ error: "Invalid JSON body" }, 400);
  }
  let pasted = String(payload?.url || "").trim();
  if (pasted && !/^https?:\/\//i.test(pasted)) pasted = "https://" + pasted;
  const website = String(payload?.website || "").trim();

  try {
    return reply({ menu: await findMenu(website, pasted, resolve) });
  } catch (err) {
    if (err instanceof MenuError) return reply({ error: err.message }, 422);
    // arbitrary websites fail in arbitrary ways
    return reply({ error: "Reading that website failed: " + String((err as Error)?.message || err) }, 502);
  }
}

if (runtime?.serve) runtime.serve((request: Request) => handle(request));
