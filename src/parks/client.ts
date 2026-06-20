/**
 * Anonymous HTTP client for Aspira/ReserveAmerica "UNIF" reservation shops
 * (e.g. shop.albertaparks.ca, parks.saskatchewan.ca). The shop host and the
 * Aspira contract code differ per jurisdiction; everything else is identical.
 *
 * Every request is gated by a Queue-it waiting room: a cold request 302s to
 * go.aspiraconnect.com, which (in safetynet mode) immediately bounces back with a
 * queue token, after which the app sets a JSESSIONID. We perform that handshake by
 * following redirects manually and keeping a cookie jar, then reuse the jar. If a
 * later request gets bounced to the queue again (token expiry), we re-handshake once.
 */

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";

/** Per-jurisdiction Aspira shop configuration. */
export interface AspiraConfig {
  /** Shop origin, e.g. "https://shop.albertaparks.ca" (no trailing slash). */
  base: string;
  /** Aspira contract code, e.g. "ABPP" (Alberta), "SKPP" (Saskatchewan). */
  contractCode: string;
}

/** Alberta Parks — the original/default instance. */
export const ALBERTA: AspiraConfig = {
  base: "https://shop.albertaparks.ca",
  contractCode: "ABPP",
};

/** Saskatchewan Provincial Parks — same Aspira platform, different host/code. */
export const SASKATCHEWAN: AspiraConfig = {
  base: "https://parks.saskatchewan.ca",
  contractCode: "SKPP",
};

// Back-compat: Alberta's contract code, used by callers that pre-date the config object.
export const CONTRACT_CODE = ALBERTA.contractCode;

export class QueueBusyError extends Error {
  constructor() {
    super("The reservation system is in a busy queue right now; try again shortly.");
    this.name = "QueueBusyError";
  }
}

/**
 * Thrown when the Queue-it waiting room re-queues every request and the upstream
 * flow can't complete. This happens for the multi-step availability flow when the
 * request egresses from an IP Queue-it won't durably trust (some datacenter ranges,
 * e.g. Cloudflare Workers and some cloud VPSs): it never grants the accepted-cookie,
 * so each redirect re-enters the queue. Flat pages (list, details) still work.
 * From a residential / trusted IP the same code returns live availability.
 */
export class QueueBlockedError extends Error {
  constructor() {
    super(
      "The reservation system's waiting room re-queues every request from this network, " +
        "so live availability can't be fetched here. Campground listing and details " +
        "still work. Availability needs a non-datacenter (residential) egress IP.",
    );
    this.name = "QueueBlockedError";
  }
}

export class ParksClient {
  private jar = new Map<string, string>();
  private ready = false;
  readonly config: AspiraConfig;

  constructor(config: AspiraConfig = ALBERTA) {
    this.config = config;
  }

  private get base(): string {
    return this.config.base;
  }

  private cookieHeader(): string {
    return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  private storeCookies(res: Response) {
    // getSetCookie() returns each Set-Cookie separately (Bun + Workers support it).
    const cookies = (res.headers as any).getSetCookie?.() as string[] | undefined;
    const list = cookies ?? (res.headers.get("set-cookie") ? [res.headers.get("set-cookie")!] : []);
    for (const c of list) {
      const pair = c.split(";")[0];
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (!value || value === "deleted") this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }

  /**
   * Follow the redirect chain from a starting URL, collecting cookies, until a 200.
   * The Queue-it handshake (shop → queue → shop) and Aspira's own internal redirects
   * all resolve here. If we never settle, that's the datacenter-IP re-queue loop
   * (see QueueBlockedError) — bail rather than spin.
   */
  private async follow(startUrl: string, maxHops = 12): Promise<Response> {
    let url = startUrl;
    for (let hop = 0; hop < maxHops; hop++) {
      const res = await fetch(url, {
        redirect: "manual",
        headers: {
          Cookie: this.cookieHeader(),
          "User-Agent": UA,
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "en-CA,en;q=0.9",
        },
      });
      this.storeCookies(res);
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) return res;
        url = new URL(loc, url).toString();
        continue;
      }
      return res;
    }
    throw new QueueBlockedError();
  }

  /** Establish a session through the Queue-it waiting room. */
  async handshake(): Promise<void> {
    const res = await this.follow(`${this.base}/`);
    if (!res.ok) throw new QueueBusyError();
    this.ready = true;
  }

  /**
   * GET a path on the shop host, establishing the queue session on first use and
   * retrying transient failures. Every request re-enters the Queue-it safetynet
   * check, which occasionally returns a non-200 or a momentary block; we re-handshake
   * and retry a couple of times before giving up so a single blip doesn't fail a tool.
   */
  async get(path: string, attempts = 3): Promise<string> {
    const url = path.startsWith("http") ? path : `${this.base}${path}`;
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        if (!this.ready) await this.handshake();
        const res = await this.follow(url);
        if (res.ok) return await res.text();
        lastErr = new QueueBusyError();
      } catch (e) {
        lastErr = e;
      }
      this.ready = false; // force a fresh handshake on the next attempt
      if (i < attempts - 1) await sleep(250 * (i + 1));
    }
    throw lastErr ?? new QueueBusyError();
  }

  /* ----- endpoint URL builders (bound to this instance's host + contract code) ----- */

  // unifSearchResults reads the server session's *current* search, so we must first
  // prime it by visiting the camping search interface, then request results.
  campingPrimeUrl(): string {
    return `/unifSearchInterface.do?interface=dsearch&interest=camping&tti=Camping`;
  }

  campingResultsUrl(): string {
    // A large pageSize returns the full camping facility list in one page.
    return `/unifSearchResults.do?contractCode=${this.config.contractCode}&interest=camping&pageNumber=1&pageSize=500`;
  }

  // Backcountry (permit) facilities — a separate "interest" with its own prime.
  backcountryPrimeUrl(): string {
    return `/unifSearchInterface.do?interface=dsearch&interest=permit&tti=Backcountry`;
  }

  backcountryResultsUrl(): string {
    return `/unifSearchResults.do?contractCode=${this.config.contractCode}&interest=permit&pageNumber=1&pageSize=500`;
  }

  /** Human booking page for a front-country campground. */
  bookingUrl(parkId: string): string {
    return `${this.base}/unifSearchInterface.do?interface=bookcamp&contractCode=${this.config.contractCode}&parkId=${parkId}`;
  }

  /** Backcountry: the "apply permit" page for an area — also primes the trip calendar. */
  applyPermitUrl(areaId: string): string {
    return `/unifSearchInterface.do?interface=applypermit&contractCode=${this.config.contractCode}&parkId=${areaId}`;
  }

  /** Backcountry booking page for an area (where its zones, e.g. Point, are reserved). */
  permitBookingUrl(areaId: string): string {
    return `${this.base}${this.applyPermitUrl(areaId)}`;
  }

  /** Backcountry trip-permit availability calendar for an area (14-day window). */
  permitCalendarUrl(areaId: string, startISO: string): string {
    const arr = toUpstreamDate(startISO);
    return `/singleTripPermitCalendar.do?page=calendar&tripPlan=true&calarvdate=${encodeURIComponent(
      arr,
    )}&contractCode=${this.config.contractCode}&parkId=${areaId}`;
  }

  calendarUrl(parkId: string, startISO: string, startIdx = 0): string {
    const arr = toUpstreamDate(startISO);
    // The grid is paginated ~10 sites at a time; startIdx walks through them.
    return `/campsiteCalendar.do?page=calendar&contractCode=${this.config.contractCode}&parkId=${parkId}&calarvdate=${encodeURIComponent(
      arr,
    )}&sitepage=true&startIdx=${startIdx}`;
  }

  facilityDetailsUrl(parkId: string): string {
    return `/facilityDetails.do?contractCode=${this.config.contractCode}&parkId=${parkId}`;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** MM/DD/YYYY in the upstream's expected format, from an ISO YYYY-MM-DD date. */
export function toUpstreamDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${m}/${d}/${y}`;
}
