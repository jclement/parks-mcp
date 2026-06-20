import type { AvailabilityResult, SiteAvailability } from "../parks/parse.ts";

export type { AvailabilityResult, SiteAvailability };

/** A bookable unit (front-country campground, backcountry zone, or trail). */
export interface CampgroundListItem {
  /** Globally-unique, provider-prefixed id, e.g. "ab:330126", "bc:-2147483646". */
  parkId: string;
  name: string;
  /** "Alberta Parks" | "BC Parks" | "Parks Canada". */
  jurisdiction: string;
  type: "campground" | "backcountry";
  region?: string;
  siteTypes: { type: string; count: number }[];
  lat?: number;
  lng?: number;
  bookingUrl: string;
}

export interface AvailabilityWithMeta extends AvailabilityResult {
  parkId: string;
  jurisdiction: string;
  bookingUrl: string;
}

export interface Vacancy {
  siteId: string;
  label: string;
  loop?: string;
  siteUrl?: string;
  quota?: string;
  checkIn: string;
  checkOut: string;
  nights: number;
}

export interface VacancyResult {
  parkId: string;
  jurisdiction: string;
  bookingUrl: string;
  vacancies: Vacancy[];
}

export interface CampgroundInfo {
  parkId: string;
  name: string;
  jurisdiction: string;
  description?: string;
  lat?: number;
  lng?: number;
  bookingUrl: string;
}

/**
 * A reservation backend (one park system). Methods take/return *local* ids (no
 * provider prefix); the registry adds/strips the `${prefix}:` and re-prefixes ids
 * in returned payloads.
 */
export interface Provider {
  prefix: string;
  jurisdiction: string;
  list(): Promise<CampgroundListItem[]>;
  availability(localId: string, startISO: string, nights: number): Promise<AvailabilityWithMeta>;
  vacancies(
    localId: string,
    startISO: string,
    endISO: string,
    nights: number,
  ): Promise<VacancyResult>;
  info(localId: string): Promise<CampgroundInfo>;
}
