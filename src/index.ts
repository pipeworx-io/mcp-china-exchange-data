interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// ── Bounded readers — peak memory, not just wall time (fleet #3322) ──────
//
// `parseJson` above does `await res.text()` then `JSON.parse(raw)`, so a
// multi-megabyte upstream body is held TWICE at peak: once as the raw string
// and once as the object graph (which for an array of small objects runs
// several times the byte size). Nothing in `workers/gateway` can see that
// peak — it happens inside the pack, before any gateway code holds a payload —
// which is why the gateway-side payload caps of #3293 and #3320 did not move
// the 503/1102 rate at all.
//
// Measured on the live gateway, 2026-10-19, sha fa5de5c34, direct tools/call:
//   statcan_list_cubes  8,049,566 B   <- one upstream array, no limit argument
//   gnomad_gene BRCA1   2,732,706 B
// Five of those in flight at the quality runner's width is ~40 MB of parse
// peak against a 128 MB isolate; Cloudflare kills the isolate and every
// request in flight returns 503/1102, which is why the victims look random.
//
// `readJsonArrayPrefix` is the fix for the dominant shape: an upstream that
// returns one enormous top-level JSON array with no server-side paging. It
// parses elements off the stream and DISCARDS the consumed bytes, so peak
// retained memory is one element plus one chunk rather than the whole body,
// and it cancels the body as soon as it has what it was asked for.

/** Default ceiling for a single upstream JSON body read into an isolate.
 *  Chosen so the known tail (statcan 8.0 MB, gnomad 2.7 MB) is bounded well
 *  below the point where a handful of concurrent reads exhausts 128 MB. */
const DEFAULT_MAX_JSON_BYTES = 1_500_000;

interface JsonArrayPrefix<T> {
  /** The decoded elements, at most `maxItems` of them. */
  items: T[];
  /** True when the upstream array had more elements than we read. */
  truncated: boolean;
  /** Bytes actually pulled off the socket — the number that bounds memory. */
  bytesRead: number;
  /** `Content-Length` if the upstream declared one, else null. */
  declaredBytes: number | null;
}

/**
 * Read the FIRST `maxItems` elements of a top-level JSON array off a response
 * stream without ever materialising the whole body.
 *
 * Use this instead of `parseJson` when the upstream returns one big array and
 * offers no `limit`/`offset` of its own. Peak retained memory is one element
 * plus the current chunk; the body is cancelled as soon as `maxItems` is
 * reached, so the remaining megabytes are never transferred at all.
 *
 *     const { items, truncated } = await readJsonArrayPrefix<Cube>(
 *       res, 'StatCan WDS', { maxItems: limit + offset });
 *
 * `maxBytes` is a second, independent backstop for a pathological element (a
 * single 50 MB object): hitting it stops the read and sets `truncated`, rather
 * than throwing, because a partial answer plus an explicit truncated flag is
 * more useful to a caller than an error.
 */
async function readJsonArrayPrefix<T>(
  res: Response,
  name: string,
  opts: { maxItems: number; maxBytes?: number },
): Promise<JsonArrayPrefix<T>> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_JSON_BYTES;
  const declaredRaw = Number(res.headers.get('content-length'));
  const declaredBytes = Number.isFinite(declaredRaw) && declaredRaw > 0 ? declaredRaw : null;

  // No streaming body available (a mock, or an already-buffered response):
  // fall back to the whole-text path so behaviour stays correct, just unbounded.
  if (!res.body) {
    const all = await parseJson<T[]>(res, name);
    if (!Array.isArray(all)) throw new Error(`upstream_down: ${name} returned ${typeof all} where a JSON array was expected.`);
    return {
      items: all.slice(0, opts.maxItems),
      truncated: all.length > opts.maxItems,
      bytesRead: declaredBytes ?? 0,
      declaredBytes,
    };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const items: T[] = [];

  let buf = '';
  let scan = 0;
  let bytesRead = 0;
  let started = false; // consumed the opening '['
  let arrayEnded = false;
  let depth = 0;
  let inStr = false;
  let esc = false;
  let elemStart = -1;
  let truncated = false;

  const push = (text: string) => {
    const t = text.trim();
    if (!t) return;
    items.push(JSON.parse(t) as T);
  };

  try {
    outer: while (items.length < opts.maxItems && !arrayEnded) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      buf += decoder.decode(value, { stream: true });
      if (bytesRead > maxBytes) { truncated = true; break; }

      for (; scan < buf.length; scan++) {
        const ch = buf[scan];

        if (inStr) {
          if (esc) { esc = false; continue; }
          if (ch === '\\') { esc = true; continue; }
          if (ch === '"') inStr = false;
          continue;
        }

        if (!started) {
          if (ch === '[') { started = true; continue; }
          if (ch.trim() === '') continue;
          throw new Error(
            `upstream_down: ${name} returned a body that does not begin with a JSON array (saw ${JSON.stringify(ch)}). ` +
              'This reader is only for upstreams that answer with one top-level array.',
          );
        }

        if (ch === '"') { if (depth === 0 && elemStart < 0) elemStart = scan; inStr = true; continue; }

        if (ch === '{' || ch === '[') {
          if (depth === 0 && elemStart < 0) elemStart = scan;
          depth++;
          continue;
        }

        if (ch === '}' || ch === ']') {
          if (depth > 0) {
            depth--;
            if (depth === 0 && elemStart >= 0) {
              push(buf.slice(elemStart, scan + 1));
              elemStart = -1;
              if (items.length >= opts.maxItems) { truncated = true; scan++; break outer; }
            }
            continue;
          }
          // depth 0 and a closing bracket: the end of the top-level array.
          if (elemStart >= 0) { push(buf.slice(elemStart, scan)); elemStart = -1; }
          arrayEnded = true;
          break outer;
        }

        if (ch === ',' && depth === 0) {
          if (elemStart >= 0) {
            push(buf.slice(elemStart, scan));
            elemStart = -1;
            if (items.length >= opts.maxItems) { truncated = true; scan++; break outer; }
          }
          continue;
        }

        // A bare scalar element (number / true / false / null).
        if (depth === 0 && elemStart < 0 && ch.trim() !== '') elemStart = scan;
      }

      // Drop everything already consumed. THIS is what bounds memory: without
      // it `buf` grows to the full body and the reader is streaming in name only.
      if (elemStart >= 0) {
        buf = buf.slice(elemStart);
        scan -= elemStart;
        elemStart = 0;
      } else {
        buf = buf.slice(scan);
        scan = 0;
      }
    }
  } finally {
    // Cancel rather than drain: the point is that the remaining megabytes are
    // never transferred. A cancel on an already-finished body is a no-op.
    await reader.cancel().catch(() => {});
  }

  return { items, truncated, bytesRead, declaredBytes };
}

/**
 * `parseJson`, with a hard ceiling on how many bytes are read.
 *
 * For an upstream whose body is not a single array (so `readJsonArrayPrefix`
 * does not apply) but which can still answer with megabytes. Unlike the array
 * reader this one THROWS when the cap is hit, because a truncated prefix of an
 * arbitrary JSON document is not parseable and there is no partial answer to
 * hand back. A declared `Content-Length` over the cap is refused before a
 * single chunk is read.
 */
async function parseJsonBounded<T>(
  res: Response,
  name: string,
  maxBytes: number = DEFAULT_MAX_JSON_BYTES,
): Promise<T> {
  const declaredRaw = Number(res.headers.get('content-length'));
  const declared = Number.isFinite(declaredRaw) && declaredRaw > 0 ? declaredRaw : null;

  const tooBig = (n: number) =>
    new Error(
      `upstream_down: ${name} answered with ${n.toLocaleString()} bytes, over this pack's ${maxBytes.toLocaleString()}-byte ceiling. ` +
        'The body is not read past the ceiling on purpose — a few concurrent reads of a body that size exhaust the ' +
        'Worker isolate and take every other in-flight request down with them. Narrow the request (a smaller range, ' +
        'a specific id, or a lower limit) and retry.',
    );

  if (declared !== null && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw tooBig(declared);
  }
  if (!res.body) return parseJson<T>(res, name);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  let bytesRead = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) throw tooBig(bytesRead);
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected. ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON. ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}
/**
 * China Exchange Data MCP (SZSE + SSE). Keyless.
 *
 * Live market data straight from the two Chinese mainland exchanges — one
 * pack because SZSE (Shenzhen) and SSE (Shanghai) are a single jurisdiction
 * (feedback_one_pack_per_jurisdiction). Fills the gap china-stocks leaves:
 * sector/industry turnover ranking, index daily/weekly bars, a full-market
 * board snapshot for screens, and company bulletins (公告) by code.
 *
 * 板块 主力资金 净流入 指数 日线 公告 — 深交所 上交所 A股行情数据接口
 *
 * SOURCES (all keyless, all require a same-site Referer header, verified live
 * 2026-09-07 from machine 0):
 *  - SZSE report API: www.szse.cn/api/report/ShowReport/data?SHOWTYPE=JSON&
 *    CATALOGID=<id> — used here for CATALOGID=1804_gptj_merge_after (股票行业
 *    统计, industry turnover statistics; requires txtQueryDate).
 *  - SZSE quote history: www.szse.cn/api/market/ssjjhq/getHistoryData?
 *    cycleType=<32|33|37>&marketId=1&code=<code> — daily(32)/weekly(33)/
 *    annual(37) OHLC bars for any SZSE-listed code OR SZSE index (399xxx).
 *    No begin/end window param — always returns full available history
 *    (confirmed back to 1991 for 399xxx indices), sliced client-side to the
 *    requested count. (cycleType 34/35/36 = monthly/quarterly/semi-annual,
 *    probed but not exposed as tool params — not asked for.) Row shape
 *    (empirically confirmed, not documented by SZSE):
 *    [date, open, close, low, high, change, change_pct, volume, amount] —
 *    change/change_pct are period-over-period (e.g. for cycleType=37, this
 *    year's close vs last year's close), computed by SZSE itself.
 *  - SSE public quote system: yunhq.sse.com.cn:32041/v1/sh1/... (plain HTTP
 *    only — the TLS port is not reachable from here). /dayk/<code>?period=
 *    day|week|year gives OHLCV bars for any SSE code OR SSE index
 *    (000xxx/999xxx); period=year confirmed live back to the 1990s. Row =
 *    [date(YYYYMMDD), open, high, low, close, volume, amount] — no
 *    change/change_pct field, so ashares_index_bars computes it here from
 *    consecutive closes (fetches one extra bar as the prior-close anchor).
 *    /list/exchange/equity gives the full SSE equity board as one paged call
 *    (~2,358 rows): [code, name, last, change_pct, volume, amount] — a
 *    real-time/latest-session snapshot, not per-symbol OHLC, and not
 *    addressable by an arbitrary past date.
 *  - SSE bulletins: query.sse.com.cn/security/stock/queryCompanyBulletinNew.do
 *    ?productId=<code> (JSONP; the working param is productId, NOT
 *    securityCode/SECURITY_CODE — those are silently ignored) — real company
 *    disclosure list with title, type, date, and PDF URL. beginDate/endDate
 *    server-side filters return 0 rows when set (broken or need an unknown
 *    format) — filtered client-side on SSEDATE instead.
 *
 * NOT built, and why:
 *  - No literal 主力资金净流入 (large-order-classified net capital inflow) —
 *    neither exchange publishes that computed metric; it's a vendor number
 *    (East Money / 同花顺 style). push2.eastmoney.com is empty from any
 *    non-China IP (project_china_ashares_pack) and is out of scope for this
 *    SZSE+SSE-sourced pack regardless. ashares_sector_flows instead reports
 *    SZSE's own official per-industry turnover ranking (成交金额/亿元,
 *    换手 volume, market cap) — a real, live, exchange-published number that
 *    answers the same "which sectors are hot today" question, labeled
 *    honestly as turnover, not net inflow.
 *  - No full-market bar set for an arbitrary PAST date. The only bulk
 *    full-market endpoint found (SSE yunhq list) is a live/latest-session
 *    snapshot; SZSE's per-catalog snapshot report (1815_stock_snapshot)
 *    requires a security code and would need one call per stock (~2,900) to
 *    reconstruct a market-wide set for a past date — not viable as a single
 *    tool call. ashares_market_bars therefore always returns the latest
 *    available SSE session and says so plainly when a different date is
 *    requested, rather than silently substituting or fabricating rows.
 */


async function pwFetch(url: string | URL, init: RequestInit, upstream: string): Promise<Response> {
  const headers = { 'User-Agent': 'pipeworx-mcp-china-exchange-data/1.0 (+https://pipeworx.io)', ...(init.headers ?? {}) };
  return fetchWithTimeout(url, { ...init, headers }, upstream);
}

const SZSE_REPORT = 'https://www.szse.cn/api/report/ShowReport/data';
const SZSE_HISTORY = 'https://www.szse.cn/api/market/ssjjhq/getHistoryData';
const SZSE_REFERER = 'https://www.szse.cn/market/trend/index.html';
// yunhq is SSE's public quote system; only plain HTTP is reachable from here
// (the documented TLS port 32041 does not respond, HTTP does).
const SSE_YUNHQ = 'http://yunhq.sse.com.cn:32041';
const SSE_BULLETIN = 'https://query.sse.com.cn/security/stock/queryCompanyBulletinNew.do';
const SSE_REFERER = 'https://www.sse.com.cn/disclosure/listedinfo/announcement/';

function num(v: unknown): number | null {
  // SZSE's ShowReport formats large numbers with thousands separators
  // (e.g. "5,200.79" for 总市值) — strip them before parsing.
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.replace(/,/g, '')) : NaN;
  return Number.isFinite(n) ? n : null;
}
function round2(v: number | null): number | null {
  return v == null ? null : Math.round(v * 100) / 100;
}
function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}
/** True if `dateStr` (YYYY-MM-DD) is the exchange's in-progress CURRENT year,
 * not yet a closed calendar year — both exchanges' annual-bar endpoints append
 * a running bar for the current year dated "today" rather than year-end until
 * the year actually closes (confirmed live 2026-10-10: the newest annual bar
 * for 000001/399001 was dated 2026-10-09, not 2026-12-3x). Treating that as a
 * completed "2026 annual close" would silently push a 6-year request to
 * 2021-2026 instead of 2020-2025 — so `years` mode drops it. Once the
 * calendar reaches the exchanges' actual year-end trading days (～Dec 29-31)
 * the bar IS the real close and is kept. */
function isPartialCurrentYear(dateStr: string): boolean {
  const today = todayISO();
  if (dateStr.slice(0, 4) !== today.slice(0, 4)) return false;
  return !(today.slice(5, 7) === '12' && Number(today.slice(8, 10)) >= 28);
}
function dropTrailingPartialYear<T extends { date: string }>(bars: T[]): T[] {
  if (bars.length === 0) return bars;
  return isPartialCurrentYear(bars[bars.length - 1].date) ? bars.slice(0, -1) : bars;
}
function stripJsonp(text: string): unknown {
  const m = text.match(/^[^(]*\(([\s\S]*)\)\s*;?\s*$/);
  const body = m ? m[1] : text;
  return JSON.parse(body);
}
/** SZSE daily/weekly history row order, confirmed empirically (undocumented by SZSE):
 *  [date, open, close, low, high, change, change_pct, volume, amount] */
function szseRow(r: unknown[]) {
  return {
    date: String(r[0]),
    open: num(r[1]),
    close: num(r[2]),
    low: num(r[3]),
    high: num(r[4]),
    change: num(r[5]),
    change_pct: num(r[6]),
    volume: num(r[7]),
    amount_cny: num(r[8]),
  };
}
/** SSE yunhq dayk row order: [date(YYYYMMDD), open, high, low, close, volume, amount] */
function sseRow(r: unknown[]) {
  const d = String(r[0]);
  return {
    date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`,
    open: num(r[1]),
    high: num(r[2]),
    low: num(r[3]),
    close: num(r[4]),
    volume: num(r[5]),
    amount_cny: num(r[6]),
  };
}

const SSE_INDICES: Record<string, string> = {
  '000001': '上证指数 Shanghai Composite',
  '000016': '上证50 SSE 50',
  '000300': '沪深300 CSI 300',
  '000688': '科创50 STAR 50',
  '000905': '中证500 CSI 500',
};
const SZSE_INDICES: Record<string, string> = {
  '399001': '深证成指 Shenzhen Component',
  '399006': '创业板指 ChiNext',
  '399905': '中证500 CSI 500 (SZSE feed)',
  '399300': '沪深300 CSI 300 (SZSE feed)',
};

function indexExchange(code: string): 'sse' | 'szse' {
  return code.startsWith('399') ? 'szse' : 'sse';
}

const tools: McpToolExport['tools'] = [
  {
    name: 'ashares_sector_flows',
    description:
      '深交所 A股行业板块统计 — SZSE-official per-industry (行业) turnover ranking for the Chinese A-share market: turnover amount (成交金额/亿元), share volume, company count, total and float market cap, and weighted-average P/E, one row per SZSE industry classification (A 农林牧渔 … T 综合 etc.), for a given trading day. This is the exchange\'s own published turnover-by-industry statistic — NOT the vendor-computed "主力资金净流入" (large-order net capital inflow) metric that East Money / 同花顺-style trackers publish; neither SZSE nor SSE discloses that classification publicly, so it is not offered here. Answers "今天A股行业板块成交额排名", "which sectors traded the most today", "SZSE industry turnover ranking". Sorted by turnover amount descending. Source: SZSE ShowReport CATALOGID=1804_gptj_merge_after (keyless).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        date: { type: 'string', description: 'Trading day as YYYY-MM-DD (default: today). SZSE returns the most recently published session if the exact date has no data yet.' },
        top: { type: 'number', description: 'How many industries to return, 1-50 (default 10, all if omitted total is under that).' },
      },
    },
  },
  {
    name: 'ashares_index_bars',
    description:
      '上证/深证指数日线周线年线 — Daily, weekly, or annual OHLC + volume + turnover bars for a major China A-share index: 上证指数 Shanghai Composite (000001), 上证50 (000016), 沪深300 CSI 300 (000300), 科创50 STAR50 (000688) from SSE; 深证成指 Shenzhen Component (399001), 创业板指 ChiNext (399006) from SZSE. Weekly history goes back up to 6 years (312 bars); `years` returns one bar per calendar year (close + year-over-year pct change) for multi-year questions like "5 years of annual closes for CSI 300". Answers "上证指数000001最近10个交易日OHLC", "Shanghai Composite last 10 days", "深证成指周线", "ChiNext index history", "CSI 300 annual close 2020-2025". Source: SSE yunhq public quote system (000xxx/999xxx indices) + SZSE ssjjhq history API (399xxx indices), both keyless.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        index: { type: 'string', description: 'Index code: 000001 (上证指数), 000016 (上证50), 000300 (沪深300), 000688 (科创50), 399001 (深证成指), 399006 (创业板指). Default 000001.' },
        days: { type: 'number', description: 'Number of daily bars to return, 1-250 (default 10). Ignored if weeks or years is set.' },
        weeks: { type: 'number', description: 'Number of weekly bars to return, 1-312 (up to ~6 years). Overrides days when set; ignored if years is set.' },
        years: { type: 'number', description: 'Number of annual bars to return, 1-40 — one bar per calendar year with close and year-over-year pct_change. Overrides weeks and days when set. E.g. years:6 for 2020-2025 inclusive.' },
      },
    },
  },
  {
    name: 'ashares_market_bars',
    description:
      "沪市全市场行情 — Full-market latest-session board snapshot for SSE-listed A-shares (~2,358 stocks): code, name, last price, change %, volume, turnover amount (成交额). Built for running screens (momentum vs index, top movers) without querying each stock individually. This is the LATEST available trading session only (a live board snapshot, not a historical-date archive) — SZSE does not expose an equivalent single-call full-market bulk endpoint (its per-stock snapshot report needs one call per code), so this tool covers the Shanghai exchange only; asking for a past date returns the latest session with a note rather than silently substituting data. Answers 'A股全市场行情', 'SSE full board today', 'screen all Shanghai A-shares by turnover'. Source: SSE yunhq public quote list (keyless).",
    inputSchema: {
      type: 'object' as const,
      properties: {
        date: { type: 'string', description: 'Requested date, YYYY-MM-DD. Informational only — the tool always returns the latest available SSE session and reports whether it matches this date.' },
        limit: { type: 'number', description: 'Max rows to return, 1-2500 (default 500). The response always reports the true total row count on the board.' },
        sort: { type: 'string', enum: ['amount', 'change_pct', 'volume'], description: 'Sort rows by turnover amount (default), change %, or volume, descending.' },
      },
    },
  },
  {
    name: 'ashares_bulletins',
    description:
      '上交所上市公司公告 — SSE-listed company disclosure bulletins (公告) by 6-digit code: title, type (半年报/年报/董事会/股东会/回购/关联交易 etc.), date, and the PDF URL on sse.com.cn. Answers "600519最新公告", "贵州茅台公司公告", "SSE company bulletins since 2026-01-01", "annual report / 年报 filings for a code". SZSE-listed codes (0/3-prefixed) are not covered — this endpoint is SSE-only. Source: SSE queryCompanyBulletinNew (keyless).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: '6-digit SSE code, e.g. "600519" (贵州茅台).' },
        since: { type: 'string', description: 'Only return bulletins on or after this date, YYYY-MM-DD (default: no lower bound — most recent first).' },
        type: { type: 'string', description: 'Filter by bulletin type substring, e.g. "年报" or "股东会" (default: all types).' },
        limit: { type: 'number', description: 'Max bulletins to return, 1-100 (default 20, newest first). The response always reports the true total on file.' },
      },
      required: ['code'],
    },
  },
];

// ── ashares_sector_flows ────────────────────────────────────────────
async function sectorFlows(args: Record<string, unknown>) {
  const date = typeof args.date === 'string' && args.date.trim() ? args.date.trim() : todayISO();
  const top = Math.min(Math.max(Number(args.top ?? 10), 1), 50);
  const params = new URLSearchParams({ SHOWTYPE: 'JSON', CATALOGID: '1804_gptj_merge_after', TABKEY: 'tab1', txtQueryDate: date, zqlbdm: 'GP' });
  const res = await pwFetch(`${SZSE_REPORT}?${params}`, { headers: { Referer: SZSE_REFERER } }, 'SZSE');
  if (!res.ok) throw await httpError(res, 'SZSE');
  const body = (await res.json()) as Array<{ data?: Array<Record<string, string>> }>;
  const rows = body[0]?.data ?? [];
  if (rows.length === 0) {
    return {
      date,
      found: false,
      message: `No SZSE industry statistics published for ${date} yet (not a trading day, or today's session not yet closed — try yesterday's date).`,
      metric: 'turnover_amount_cny_100m (成交金额, 亿元) — official SZSE per-industry turnover, NOT the vendor "主力资金净流入" large-order net-inflow metric, which neither exchange publishes.',
    };
  }
  const industries = rows
    .map((r) => ({
      industry: r.hymc ?? null,
      stock_count: num(r.zqsl),
      company_count: num(r.gsjs),
      turnover_amount_cny_100m: num(r.cjje),
      turnover_volume_100m_shares: num(r.cjsl),
      total_market_cap_cny_100m: num(r.sjzz),
      float_market_cap_cny_100m: num(r.ltsz),
      weighted_avg_pe: num(r.jqpj),
    }))
    .filter((r) => r.turnover_amount_cny_100m != null && r.industry !== '总计') // SZSE includes a market-wide "总计" (Total) row alongside real industries
    .sort((a, b) => (b.turnover_amount_cny_100m ?? 0) - (a.turnover_amount_cny_100m ?? 0));
  return {
    date,
    found: true,
    total_industries: industries.length,
    metric: 'turnover_amount_cny_100m (成交金额, 亿元) — official SZSE per-industry turnover ranking, NOT the vendor "主力资金净流入" large-order net-inflow metric (neither SZSE nor SSE publishes that).',
    industries: industries.slice(0, top),
    source: 'SZSE ShowReport CATALOGID=1804_gptj_merge_after (股票行业统计)',
  };
}

// ── ashares_index_bars ──────────────────────────────────────────────
async function indexBars(args: Record<string, unknown>) {
  const code = typeof args.index === 'string' && args.index.trim() ? args.index.trim() : '000001';
  // years > weeks > days. Weekly ceiling raised 104 -> 312 (~6y); years is new
  // (both exchanges expose a native annual cycle — confirmed live 2026-10-10:
  // SZSE cycleType=37, SSE yunhq period=year — so this is a real upstream bar
  // size, not a client-side aggregation).
  const years = args.years != null ? Math.min(Math.max(Number(args.years), 1), 40) : null;
  const weeks = years == null && args.weeks != null ? Math.min(Math.max(Number(args.weeks), 1), 312) : null;
  const days = years == null && weeks == null ? Math.min(Math.max(Number(args.days ?? 10), 1), 250) : null;
  const want = (years ?? weeks ?? days) as number;
  const period = years != null ? 'annual' : weeks != null ? 'weekly' : 'daily';
  const exch = indexExchange(code);
  const name = exch === 'sse' ? SSE_INDICES[code] : SZSE_INDICES[code];

  if (exch === 'szse') {
    // SZSE cycleType: 32 daily, 33 weekly, 37 annual (confirmed live; 34/35/36
    // are monthly/quarterly/semi-annual, not used here). getHistoryData has no
    // begin/end window param — it always returns full available history and
    // we slice client-side, which is also how the weekly ceiling raise works
    // with no upstream change. change/change_pct in the row are already
    // period-over-period (confirmed: 2020 annual change = 2020 close - 2019
    // close for 399001), so no recomputation needed here.
    const cycleType = years != null ? 37 : weeks != null ? 33 : 32;
    const params = new URLSearchParams({ random: String(Math.random()), cycleType: String(cycleType), marketId: '1', code });
    const res = await pwFetch(`${SZSE_HISTORY}?${params}`, { headers: { Referer: SZSE_REFERER } }, 'SZSE');
    if (!res.ok) throw await httpError(res, 'SZSE');
    const body = (await res.json()) as { code?: string; data?: { code?: string; name?: string; picupdata?: unknown[][] } };
    if (body.code !== '0' || !body.data?.picupdata) {
      return { index: code, name: name ?? body.data?.name ?? null, found: false, message: `No SZSE history for index ${code}.` };
    }
    // For annual, fetch a small margin so dropping the in-progress current
    // year still leaves `want` closed years (full history is always returned
    // here regardless, so this costs nothing extra upstream).
    let bars = body.data.picupdata.slice(-(want + (years != null ? 2 : 0))).map((r) => szseRow(r));
    if (years != null) bars = dropTrailingPartialYear(bars);
    bars = bars.slice(-want);
    return {
      index: code,
      name: name ?? body.data.name ?? null,
      period,
      bar_count: bars.length,
      bars,
      source: years != null
        ? 'SZSE ssjjhq getHistoryData (cycleType=37 annual, marketId=1) — one bar per calendar year; change/change_pct are SZSE-computed year-over-year close deltas'
        : 'SZSE ssjjhq getHistoryData (cycleType=32 daily / 33 weekly, marketId=1) — undocumented row order confirmed empirically as [date, open, close, low, high, change, change_pct, volume, amount]',
    };
  }

  // SSE via yunhq: /v1/sh1/dayk/<code>?begin=-N&end=-1&period=day|week|year
  // (period=year confirmed live 2026-10-10 — e.g. 000001 has 37 annual bars
  // back to the 1990s). Two things to compensate for, both confirmed live:
  //  (a) yunhq's "begin=-N" is off by one — it returns N-1 bars, not N (this
  //      IS the original bug symptom: weeks:104 returned bar_count 103).
  //  (b) yunhq's row has no change/change_pct field, so we compute it here
  //      from consecutive closes, which needs one extra prior-close anchor.
  // For annual we also need one more so dropping the in-progress current
  // year still leaves `want` closed years.
  const upstreamPeriod = years != null ? 'year' : weeks != null ? 'week' : 'day';
  const offByOne = 1; // (a)
  const anchorExtra = 1; // (b)
  const partialYearExtra = years != null ? 1 : 0;
  const requestN = want + offByOne + anchorExtra + partialYearExtra;
  const url = `${SSE_YUNHQ}/v1/sh1/dayk/${encodeURIComponent(code)}?begin=-${requestN}&end=-1&period=${upstreamPeriod}`;
  const res = await pwFetch(url, {}, 'SSE');
  if (!res.ok) throw await httpError(res, 'SSE');
  const body = (await res.json()) as { code?: string; kline?: unknown[][] };
  if (!body.kline || body.kline.length === 0) {
    return { index: code, name: name ?? null, found: false, message: `No SSE history for index ${code}.` };
  }
  const parsed = body.kline.map((r) => sseRow(r));
  let withChange = parsed.map((r, i) => {
    const prevClose = i > 0 ? parsed[i - 1].close : null;
    const change = prevClose != null && r.close != null ? round2(r.close - prevClose) : null;
    const change_pct = prevClose != null && r.close != null && prevClose !== 0 ? round2(((r.close - prevClose) / prevClose) * 100) : null;
    return { ...r, change, change_pct };
  });
  if (years != null) withChange = dropTrailingPartialYear(withChange);
  const bars = withChange.length > want ? withChange.slice(-want) : withChange;
  return {
    index: code,
    name: name ?? null,
    period,
    bar_count: bars.length,
    bars,
    source: years != null
      ? 'SSE yunhq public quote system /v1/sh1/dayk period=year — one bar per calendar year; change/change_pct computed here (close vs prior year close) since SSE does not return them'
      : 'SSE yunhq public quote system /v1/sh1/dayk (row = [date, open, high, low, close, volume, amount]; change/change_pct computed here from consecutive closes)',
  };
}

// ── ashares_market_bars ─────────────────────────────────────────────
async function marketBars(args: Record<string, unknown>) {
  const requestedDate = typeof args.date === 'string' && args.date.trim() ? args.date.trim() : null;
  const limit = Math.min(Math.max(Number(args.limit ?? 500), 1), 2500);
  const sort = typeof args.sort === 'string' ? args.sort : 'amount';

  const PAGE = 500;
  const rows: Array<{ code: string; name: string; last: number | null; change_pct: number | null; volume: number | null; amount_cny: number | null }> = [];
  let total = 0;
  let sessionDate: string | null = null;
  for (let begin = 0; begin < limit; begin += PAGE) {
    const end = Math.min(begin + PAGE, limit);
    const url = `${SSE_YUNHQ}/v1/sh1/list/exchange/equity?select=code,name,last,chg_rate,volume,amount&begin=${begin}&end=${end}`;
    const res = await pwFetch(url, {}, 'SSE');
    if (!res.ok) throw await httpError(res, 'SSE');
    const text = await res.text();
    const body = stripJsonp(text) as { date?: number; total?: number; list?: unknown[][] };
    total = body.total ?? total;
    sessionDate = body.date ? String(body.date) : sessionDate;
    for (const r of body.list ?? []) {
      rows.push({ code: String(r[0]), name: String(r[1]), last: num(r[2]), change_pct: round2(num(r[3])), volume: num(r[4]), amount_cny: num(r[5]) });
    }
    if (!body.list || body.list.length < PAGE) break;
  }
  const sortKey = sort === 'change_pct' ? 'change_pct' : sort === 'volume' ? 'volume' : 'amount_cny';
  rows.sort((a, b) => (b[sortKey] ?? -Infinity) - (a[sortKey] ?? -Infinity));

  const sessionISO = sessionDate ? `${sessionDate.slice(0, 4)}-${sessionDate.slice(4, 6)}-${sessionDate.slice(6, 8)}` : null;
  return {
    requested_date: requestedDate,
    session_date: sessionISO,
    date_note:
      requestedDate && requestedDate !== sessionISO
        ? `Requested ${requestedDate} but this source only serves the latest available session (${sessionISO}) — SSE's public bulk board list is a live snapshot, not a historical-date archive.`
        : null,
    exchange: 'sse',
    total_on_board: total,
    row_count: rows.length,
    rows,
    source: 'SSE yunhq public quote system /v1/sh1/list/exchange/equity — SSE main+STAR board only; SZSE not covered by any single-call full-market endpoint found (see pack README).',
  };
}

// ── ashares_bulletins ────────────────────────────────────────────────
async function bulletins(args: Record<string, unknown>) {
  const code = typeof args.code === 'string' ? args.code.trim() : '';
  if (!/^\d{6}$/.test(code)) throw new Error('code must be a 6-digit SSE code, e.g. "600519"');
  const since = typeof args.since === 'string' && args.since.trim() ? args.since.trim() : null;
  const typeFilter = typeof args.type === 'string' && args.type.trim() ? args.type.trim() : null;
  const limit = Math.min(Math.max(Number(args.limit ?? 20), 1), 100);

  type Item = { BULLETIN_TYPE_DESC?: string; SSEDATE?: string; TITLE?: string; SECURITY_NAME?: string; URL?: string };
  const collected: Item[] = [];
  let total = 0;
  const PAGE_SIZE = 50;
  for (let page = 1; page <= 6; page++) {
    const cb = `jsonpCallback${Math.floor(Math.random() * 1e8)}`;
    const params = new URLSearchParams({
      jsonCallBack: cb,
      isPagination: 'true',
      productId: code,
      // This endpoint silently returns total:0/data:[] (a fully-formed,
      // valid-looking empty response, not an error) unless EVERY one of
      // these fields is present in the querystring — even the ones left
      // blank. Confirmed by bisection: dropping securityCode/SECURITY_CODE
      // or any reportType2-6 field alone is enough to empty the result.
      securityCode: code,
      SECURITY_CODE: code,
      reportType2: '',
      reportType3: '',
      reportType4: '',
      reportType5: '',
      reportType6: '',
      beginDate: '',
      endDate: '',
      'pageHelp.pageSize': String(PAGE_SIZE),
      'pageHelp.pageNo': String(page),
      'pageHelp.beginPage': String(page),
      'pageHelp.endPage': String(page),
      'pageHelp.cacheSize': '1',
      // query.sse.com.cn also caches by full querystring — a reused `_`
      // value can serve a stale/empty response from an earlier probe with
      // different params. Always a fresh value.
      _: `${Date.now()}${Math.floor(Math.random() * 1000)}`,
    });
    const res = await pwFetch(`${SSE_BULLETIN}?${params}`, { headers: { Referer: SSE_REFERER } }, 'SSE');
    if (!res.ok) throw await httpError(res, 'SSE');
    const text = await res.text();
    const body = stripJsonp(text) as { pageHelp?: { data?: Item[][]; total?: number; pageCount?: number } };
    total = body.pageHelp?.total ?? total;
    const groups = body.pageHelp?.data ?? [];
    for (const g of groups) for (const item of g) collected.push(item);
    const oldestOnPage = groups.length ? groups[groups.length - 1]?.[0]?.SSEDATE : undefined;
    const pageCount = body.pageHelp?.pageCount ?? 1;
    if (page >= pageCount) break;
    if (since && oldestOnPage && oldestOnPage < since) break; // dates are newest-first; stop once we're past `since`
    if (collected.length >= limit * 3) break; // enough headroom after client-side filtering
  }

  let items = collected.map((it) => ({
    date: it.SSEDATE ?? null,
    type: it.BULLETIN_TYPE_DESC ?? null,
    title: it.TITLE ?? null,
    company: it.SECURITY_NAME ?? null,
    url: it.URL ? `https://www.sse.com.cn${it.URL}` : null,
  }));
  if (since) items = items.filter((it) => it.date && it.date >= since);
  if (typeFilter) items = items.filter((it) => it.type && it.type.includes(typeFilter));

  return {
    code,
    since,
    type_filter: typeFilter,
    total_on_file: total,
    returned: Math.min(items.length, limit),
    bulletins: items.slice(0, limit),
    source: 'SSE queryCompanyBulletinNew (query.sse.com.cn) — SSE-listed companies only. Server-side beginDate/endDate params return 0 rows (broken/undocumented format), so `since` is applied client-side.',
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'ashares_sector_flows':
      return sectorFlows(args);
    case 'ashares_index_bars':
      return indexBars(args);
    case 'ashares_market_bars':
      return marketBars(args);
    case 'ashares_bulletins':
      return bulletins(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
