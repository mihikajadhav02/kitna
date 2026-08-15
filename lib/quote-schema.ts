import { z } from "zod";

/**
 * The spine of the project.
 *
 * Every provider answers a different question when you ask "how much?".
 * This schema is the shape we force all of those answers into so they can
 * sit in the same table and actually be compared.
 *
 * Design rule: every uncertain field is nullable, and null means
 * "we asked and did not get a usable answer" — never zero, never a guess.
 */

/** Tri-state. `null` is load-bearing: it means unknown, not false. */
export const TriState = z.boolean().nullable();

export const QuoteStatus = z.enum([
  "quoted", // usable price with known inclusions
  "partial", // got a number, but key inclusions still unknown
  "no_quote", // reached them, they would not or could not quote
  "unreachable", // voicemail, busy, no answer
]);
export type QuoteStatus = z.infer<typeof QuoteStatus>;

export const PriceUnit = z.enum([
  "total", // this price covers the whole request
  "per_test", // price is for ONE test, must be multiplied
  "per_visit", // price recurs per visit
  "per_item", // price recurs per item
]);
export type PriceUnit = z.infer<typeof PriceUnit>;

/**
 * Provenance. This is the trust feature — every number in the UI must be
 * traceable back to a literal thing a human said on the call.
 */
export const SourceQuote = z.object({
  /** Which field of the Quote this line supports, e.g. "basePrice". */
  field: z.string(),
  /** Verbatim transcript line. Do NOT paraphrase, clean up, or translate. */
  verbatim: z.string(),
  /** Index into the call transcript array, for audio replay. */
  turnIndex: z.number().int().min(0),
});
export type SourceQuote = z.infer<typeof SourceQuote>;

export const Inclusions = z.object({
  /** Home sample collection included in the base price? */
  homeCollection: TriState,
  /** GST included in the quoted number? */
  gst: TriState,
  /** Digital or couriered report included? */
  reportDelivery: TriState,
  /** Consumables / registration / handling charges included? */
  consumables: TriState,
});
export type Inclusions = z.infer<typeof Inclusions>;

export const Quote = z.object({
  providerId: z.string(),
  providerName: z.string(),
  status: QuoteStatus,

  /** What the provider actually said the price was. null if never quoted. */
  basePrice: z.number().nonnegative().nullable(),
  currency: z.literal("INR").default("INR"),
  unit: PriceUnit.nullable(),

  inclusions: Inclusions,

  /**
   * Named extras the provider disclosed, with amounts where given.
   * e.g. { label: "home collection", amount: 150 }
   */
  extras: z
    .array(
      z.object({
        label: z.string(),
        amount: z.number().nonnegative().nullable(),
      })
    )
    .default([]),

  /** Individually priced tests, populated only when the provider itemises them. */
  lineItems: z
    .array(
      z.object({
        test: z.string(),
        price: z.number().nonnegative().nullable(),
      })
    )
    .default([]),

  /**
   * Comparable all-in figure: basePrice + known extras + GST if excluded.
   * null whenever an unknown could move the number — better to show a gap
   * than a confident wrong total. See computeAllIn().
   */
  allInPrice: z.number().nonnegative().nullable(),

  /** Human-readable assumptions behind allInPrice, shown on hover. */
  allInAssumptions: z.array(z.string()).default([]),

  /** Strings the user needs to know: "3 visit minimum", "cash only". */
  conditions: z.array(z.string()).default([]),

  /** Turnaround for results, in hours. */
  turnaroundHours: z.number().positive().nullable(),

  /** Free-text availability, e.g. "slots from Monday 7am". */
  availability: z.string().nullable(),

  /** 0-1. Below 0.5 the UI should visibly warn. */
  confidence: z.number().min(0).max(1),

  sourceQuotes: z.array(SourceQuote).default([]),

  /** Things we asked that they dodged. Displayed, never hidden. */
  unansweredQuestions: z.array(z.string()).default([]),

  /** Set when status is no_quote or unreachable. */
  failureReason: z.string().nullable().default(null),
});
export type Quote = z.infer<typeof Quote>;

/**
 * Safe fallback. If extraction throws or the model returns garbage, return
 * this rather than crashing the run — a missing cell is survivable mid-demo,
 * an exception is not.
 */
export function emptyQuote(
  providerId: string,
  providerName: string,
  failureReason = "Extraction failed"
): Quote {
  return {
    providerId,
    providerName,
    status: "no_quote",
    basePrice: null,
    currency: "INR",
    unit: null,
    inclusions: {
      homeCollection: null,
      gst: null,
      reportDelivery: null,
      consumables: null,
    },
    extras: [],
    lineItems: [],
    allInPrice: null,
    allInAssumptions: [],
    conditions: [],
    turnaroundHours: null,
    availability: null,
    confidence: 0,
    sourceQuotes: [],
    unansweredQuestions: [],
    failureReason,
  };
}

const GST_RATE = 0.18;

/**
 * Normalise to a comparable number.
 *
 * Refuses to produce a total when an unknown could move it. That refusal is
 * the honest behaviour and should be surfaced in the UI as "incomplete",
 * not silently filled in.
 */
export function computeAllIn(
  q: Quote,
  opts: { testCount?: number } = {}
): { allInPrice: number | null; assumptions: string[] } {
  const assumptions: string[] = [];

  if (q.basePrice === null) {
    return { allInPrice: null, assumptions: ["No base price was quoted."] };
  }

  let total = q.basePrice;

  // Unit normalisation
  if (q.unit === "per_test") {
    const n = opts.testCount ?? 1;
    total *= n;
    assumptions.push(`Quoted per test; multiplied by ${n} tests.`);
  } else if (q.unit === "per_visit" || q.unit === "per_item") {
    assumptions.push(`Quoted ${q.unit.replace("_", " ")}; shown for one.`);
  } else if (q.unit === null) {
    return {
      allInPrice: null,
      assumptions: ["Unclear whether the price is total or per test."],
    };
  }

  // Known extras
  for (const e of q.extras) {
    if (e.amount === null) {
      return {
        allInPrice: null,
        assumptions: [`"${e.label}" was mentioned but never priced.`],
      };
    }
    total += e.amount;
    assumptions.push(`+ ₹${e.amount} ${e.label}.`);
  }

  // GST
  if (q.inclusions.gst === false) {
    total = Math.round(total * (1 + GST_RATE));
    assumptions.push(`+ ${GST_RATE * 100}% GST (stated as extra).`);
  } else if (q.inclusions.gst === null) {
    return {
      allInPrice: null,
      assumptions: ["Never confirmed whether GST is included."],
    };
  }

  // A dangling unknown inclusion can still move the number.
  const unknowns = (
    ["homeCollection", "reportDelivery", "consumables"] as const
  ).filter((k) => q.inclusions[k] === null);

  if (unknowns.length > 0) {
    return {
      allInPrice: null,
      assumptions: [`Unconfirmed: ${unknowns.join(", ")}.`],
    };
  }

  return { allInPrice: Math.round(total), assumptions };
}

/** One-line summary for tiles and screen readers. */
export function formatQuote(q: Quote): string {
  if (q.status === "unreachable") {
    return `${q.providerName} — no answer${
      q.failureReason ? ` (${q.failureReason})` : ""
    }`;
  }
  if (q.status === "no_quote") {
    return `${q.providerName} — no quote${
      q.failureReason ? ` (${q.failureReason})` : ""
    }`;
  }

  const price =
    q.allInPrice !== null
      ? `₹${q.allInPrice} all-in`
      : q.basePrice !== null
      ? `₹${q.basePrice} + unknowns`
      : "no price";

  const caveat =
    q.unansweredQuestions.length > 0
      ? ` · ${q.unansweredQuestions.length} unanswered`
      : "";

  return `${q.providerName} — ${price}${caveat}`;
}

/** Cheapest-first, with incomplete quotes sorted after complete ones. */
export function rankQuotes(quotes: Quote[]): Quote[] {
  return [...quotes].sort((a, b) => {
    const rank = (q: Quote) =>
      q.allInPrice !== null ? 0 : q.basePrice !== null ? 1 : 2;
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    return (a.allInPrice ?? a.basePrice ?? 0) - (b.allInPrice ?? b.basePrice ?? 0);
  });
}
