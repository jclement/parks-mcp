import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  parseCampgrounds,
  parseAvailability,
  parseFacilityDetails,
  parseBackcountryCalendar,
} from "../src/parks/parse.ts";
import { sitesFromAvailability } from "../src/providers/camis.ts";

const fx = (name: string) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");

describe("parseCampgrounds", () => {
  const parks = parseCampgrounds(fx("search.html"));

  it("finds campgrounds with ids and names", () => {
    expect(parks.length).toBeGreaterThan(0);
    for (const p of parks) {
      expect(p.parkId).toMatch(/^\d{5,7}$/);
      expect(p.name.length).toBeGreaterThan(0);
    }
  });

  it("includes Beaver Lake (330126) with a clean name", () => {
    const bl = parks.find((p) => p.parkId === "330126");
    expect(bl).toBeTruthy();
    expect(bl!.name).toBe("Beaver Lake Provincial Recreation Area");
  });

  it("captures site types with counts", () => {
    const bl = parks.find((p) => p.parkId === "330126")!;
    expect(bl.siteTypes.length).toBeGreaterThan(0);
    const power = bl.siteTypes.find((s) => s.type === "Power Site");
    expect(power).toBeTruthy();
    expect(power!.count).toBeGreaterThan(0);
  });
});

describe("parseAvailability", () => {
  const res = parseAvailability(fx("calendar.html"), "2026-07-15");

  it("extracts the park slug and a 14-day window", () => {
    expect(res.parkSlug).toBe("beaver-lake-provincial-recreation-area");
    expect(res.dates.length).toBe(14);
    expect(res.dates[0]).toBe("2026-07-15");
    expect(res.dates[13]).toBe("2026-07-28");
  });

  it("lists sites with available dates", () => {
    expect(res.sites.length).toBeGreaterThan(0);
    const withAvail = res.sites.filter((s) => s.available.length > 0);
    expect(withAvail.length).toBeGreaterThan(0);
  });

  it("site 38546 (label 04) is available on the arrival date", () => {
    const s = res.sites.find((x) => x.siteId === "38546");
    expect(s).toBeTruthy();
    expect(s!.label).toBe("04");
    expect(s!.available).toContain("2026-07-15");
  });

  it("captures a per-site booking URL", () => {
    const s = res.sites.find((x) => x.siteId === "38546")!;
    expect(s.siteUrl).toContain("campsiteDetails.do");
    expect(s.siteUrl).toContain("siteId=38546");
    expect(s.siteUrl!.startsWith("https://")).toBe(true);
  });

  it("only emits ISO dates within the window", () => {
    for (const s of res.sites) {
      for (const d of s.available) {
        expect(res.dates).toContain(d);
      }
    }
  });
});

describe("parseBackcountryCalendar", () => {
  const zones = parseBackcountryCalendar(fx("backcountry.html"), "2026-07-15");

  it("parses the 5 Kananaskis Lake zones including Point", () => {
    const names = zones.map((z) => z.zone);
    expect(names).toContain("Point");
    expect(names).toContain("Aster Lake");
    expect(names).toContain("Three Isle Lake");
    expect(zones.length).toBe(5);
  });

  it("emits available ISO dates and a booking URL where available", () => {
    const within = (d: string) => d >= "2026-07-15" && d <= "2026-07-28";
    for (const z of zones) {
      for (const d of z.available) expect(within(d)).toBe(true);
      if (z.available.length) {
        expect(z.siteUrl).toContain("entranceDetails.do");
        expect(z.quota).toMatch(/\d+ of \d+/);
      }
    }
  });
});

describe("sitesFromAvailability (Camis)", () => {
  const dates = ["2026-08-01", "2026-08-02", "2026-08-03"];

  it("treats availability===0 as available, everything else as not", () => {
    const raw = {
      "-100": [{ availability: 0 }, { availability: 1 }, { availability: 0 }],
      "-200": [{ availability: 5 }, { availability: 5 }, { availability: 5 }],
    };
    const sites = sitesFromAvailability(raw, dates);
    const a = sites.find((s) => s.siteId === "-100")!;
    const b = sites.find((s) => s.siteId === "-200")!;
    expect(a.available).toEqual(["2026-08-01", "2026-08-03"]);
    expect(b.available).toEqual([]);
  });

  it("handles missing data", () => {
    expect(sitesFromAvailability(undefined, dates)).toEqual([]);
  });
});

describe("parseFacilityDetails", () => {
  it("extracts name, description, and coordinates", () => {
    const html = `<html><head><title>Beaver Lake | Alberta Parks</title></head>
      <body><h1>Beaver Lake Provincial Recreation Area</h1>
      <div class="facility_description">A lovely lake.</div>
      <div>Geography:<p>Latitude: 54.75668&deg; Longitude: -111.87873&deg;</p></div>
      </body></html>`;
    const d = parseFacilityDetails(html);
    expect(d.name).toBe("Beaver Lake Provincial Recreation Area");
    expect(d.description).toContain("lovely lake");
    expect(d.lat).toBeCloseTo(54.75668, 4);
    expect(d.lng).toBeCloseTo(-111.87873, 4);
  });
});
