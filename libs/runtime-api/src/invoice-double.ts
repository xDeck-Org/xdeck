/**
 * §9.166 Step 6 chunk 5C2 — an in-memory invoice ledger for SIBLING REPOS to test against.
 *
 * A vertical (`restroin-core`, `clinicloud-billing`) must be able to prove its billing flow
 * without the platform backend. `mockTenantRuntime` answers every call with `undefined`,
 * which proves the capability declarations and nothing about money. This double behaves
 * like the ledger for the part of it a vertical's flow actually exercises — numbering,
 * idempotency, tenders, over-application, void — and REFUSES with the kernel's own codes.
 *
 * ── What it models exactly, and what it refuses to approximate ───────────────
 * Arithmetic is `india-gst@1`'s exclusive-price branch for a REGULAR seller, to the paisa:
 * half-up line gross, per-line tax, CGST+SGST with the odd paisa to CGST (intra-region) or
 * IGST (inter-region), the header as the sum of lines. A backend spec runs a grid of lines
 * through this AND the real calculator and requires identical results.
 *
 * It does NOT model tax-inclusive prices, cess, invoice-level discount, credit notes,
 * reconciliation, refunds or online money. Each refuses with `INVOICE_DOUBLE_NOT_MODELLED`
 * naming the branch. A double that is slightly wrong about money is worse than one that
 * says it does not know: the first produces tests that pass here and fail live.
 *
 * Also not modelled, and stated rather than hidden: the kernel PII-screens line text and
 * this does not; HSN codes are not required here (the kernel requires them per issuer).
 * `summary` aggregates what the double holds (§9.166 part 12d-k): with no credit note, refund
 * or reconciliation here, `creditedMinor` is always 0; `changes` stays not modelled.
 *
 * ── Same refusals, same codes ────────────────────────────────────────────────
 * The codes are the kernel's (`DECK_INVOICE_*`), pinned by a backend spec to the kernel's
 * error table, and every refusal carries `code` and `details` the way a real refusal
 * arrives through the sandbox. Returned documents are deep-frozen and the store keeps its
 * own copies, so a test cannot "edit" an issued invoice any more than production can.
 * Numbers render `T/DBL-00001`: visibly not a tax invoice, like every non-prod number.
 */
import type {
  InvoiceAPI,
  InvoiceBalance,
  InvoiceClosureResult,
  InvoiceComputedLine,
  InvoiceIssuePayload,
  InvoiceIssueResult,
  InvoiceLineDraft,
  InvoiceListPayload,
  InvoiceListResult,
  InvoicePaymentView,
  InvoicePaymentsPayload,
  InvoicePaymentsResult,
  InvoiceQuotePayload,
  InvoiceQuoteResult,
  InvoiceRecordTenderPayload,
  InvoiceStatusCode,
  InvoiceSummary,
  InvoiceSummaryRow,
  InvoiceTaxBreakupEntry,
  InvoiceTaxComponentCode,
  InvoiceTenderResult,
  InvoiceView,
  InvoiceVoidPayload
} from './invoice';

/** Thrown for a branch the double does not model. Deliberately NOT a kernel code. */
export const INVOICE_DOUBLE_NOT_MODELLED = 'INVOICE_DOUBLE_NOT_MODELLED';

/** Every KERNEL code this double can throw — pinned to the kernel's error table by a backend spec. */
export const INVOICE_DOUBLE_REFUSAL_CODES = Object.freeze([
  'DECK_INVOICE_INVALID_INPUT',
  'DECK_INVOICE_IDEMPOTENCY_MISMATCH',
  'DECK_INVOICE_NOT_FOUND',
  'DECK_INVOICE_HUMAN_ACTOR_REQUIRED',
  'DECK_INVOICE_NOT_OPEN',
  'DECK_INVOICE_OVER_APPLICATION',
  'DECK_INVOICE_EXTERNAL_REF_REQUIRED',
  'DECK_INVOICE_EXTERNAL_REF_ALREADY_USED',
  'DECK_INVOICE_VOID_NOT_ALLOWED',
  'DECK_INVOICE_TOTAL_MISMATCH'
] as const);

type RefusalCode = (typeof INVOICE_DOUBLE_REFUSAL_CODES)[number] | typeof INVOICE_DOUBLE_NOT_MODELLED;

/** ADR-0010 D4 — duplicated from `@xdeck/shared-types` (this library has no dependencies); pinned equal by a backend spec. */
export const INVOICE_DOUBLE_IDEMPOTENCY_KEY_RE = /^[^\s:]+:[^\s:]+:(?:0|[1-9][0-9]*)$/;

/** The offline tender kinds and their flags — pinned to the kernel's seed by a backend spec. */
export const INVOICE_DOUBLE_TENDER_KINDS: Readonly<
  Record<string, { requiresExternalRef: boolean; refIsSettlementKey: boolean; provisionalUntilReconciled: boolean }>
> = Object.freeze({
  cash: { requiresExternalRef: false, refIsSettlementKey: false, provisionalUntilReconciled: false },
  upi_external: { requiresExternalRef: true, refIsSettlementKey: true, provisionalUntilReconciled: true },
  card_terminal: { requiresExternalRef: true, refIsSettlementKey: false, provisionalUntilReconciled: true },
  bank_transfer: { requiresExternalRef: true, refIsSettlementKey: true, provisionalUntilReconciled: true },
  cheque: { requiresExternalRef: true, refIsSettlementKey: false, provisionalUntilReconciled: true },
  voucher: { requiresExternalRef: true, refIsSettlementKey: true, provisionalUntilReconciled: false }
});

/** Human-selectable void reasons — pinned to the kernel's seed by a backend spec. */
export const INVOICE_DOUBLE_VOID_REASONS: readonly string[] = Object.freeze(['entered_in_error', 'duplicate']);

export interface InMemoryInvoiceLedgerOptions {
  /** The calling package — stamped as `sourcePackage` on every document. */
  packageName?: string;
  /** Who is calling. Recording cash or voiding needs a person, exactly as in the kernel. */
  actor?: { kind: 'user' | 'device' | 'consumer' | 'system'; userId?: string | null };
  /** The seller: a REGULAR GST registrant. Only its state code changes the arithmetic. */
  issuer?: { id?: string; regionCode?: string };
  /** Injectable clock, for the same-day void rule. */
  now?: () => Date;
}

export interface InMemoryInvoiceLedger extends InvoiceAPI {
  /** Every document issued so far, frozen — for assertions a list call would page through. */
  __documents(): readonly InvoiceView[];
}

const ISSUE_KEYS: Record<keyof InvoiceIssuePayload, true> = {
  idempotencyKey: true,
  sourceRef: true,
  scopeRef: true,
  payer: true,
  placeOfSupplyRegion: true,
  lines: true,
  invoiceDiscountMinor: true,
  supplyAt: true,
  dueAt: true,
  expectTotalMinor: true
};
const QUOTE_KEYS: Record<keyof InvoiceQuotePayload, true> = {
  scopeRef: true,
  payer: true,
  placeOfSupplyRegion: true,
  lines: true,
  invoiceDiscountMinor: true
};
const LINE_KEYS: Record<keyof InvoiceLineDraft, true> = {
  description: true,
  hsnSac: true,
  quantityMilli: true,
  unitCode: true,
  unitPriceMinor: true,
  discountMinor: true,
  taxRateBp: true,
  cessRateBp: true,
  priceIncludesTax: true,
  serviceDate: true,
  sourceLineRef: true
};
const TENDER_KEYS: Record<keyof InvoiceRecordTenderPayload, true> = {
  invoiceId: true,
  tenderKindCode: true,
  amountMinor: true,
  externalRef: true,
  idempotencyKey: true
};
const VOID_KEYS: Record<keyof InvoiceVoidPayload, true> = { invoiceId: true, reasonCode: true, reasonText: true };
const LIST_KEYS: Record<keyof InvoiceListPayload, true> = {
  limit: true,
  cursor: true,
  statusCodes: true,
  payerLinkId: true,
  scopeRef: true,
  // §9.166 part 12d-k.
  createdFrom: true,
  createdBefore: true
};
const PAYMENTS_KEYS: Record<keyof InvoicePaymentsPayload, true> = { invoiceId: true, limit: true, cursor: true };
/** The kernel's bound on a page of payments (D-12bp-4). */
const PAYMENTS_PAGE_MAX = 100;

class InvoiceDoubleRefusal extends Error {
  constructor(
    readonly code: RefusalCode,
    message: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(`${code}: ${message}`);
    this.name = 'InvoiceDoubleRefusal';
  }
}

const refuse = (code: RefusalCode, message: string, details: Record<string, unknown> = {}): never => {
  throw new InvoiceDoubleRefusal(code, message, details);
};
const invalid = (field: string, rule: string): never =>
  refuse('DECK_INVOICE_INVALID_INPUT', `${field} ${rule}`, { field, rule });
const notModelled = (what: string): never =>
  refuse(INVOICE_DOUBLE_NOT_MODELLED, `${what} is not modelled by the invoice double — test it through a real deck`, {
    branch: what
  });

const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n);

/**
 * §9.166 part 12d-k (D-12dk-2) — the kernel's `parseLedgerInstant` and its two refusal rules, read the same way: a
 * full ISO-8601 instant with seconds and a zone (`Z` or `±HH:MM`), at most milliseconds, on a date that exists.
 * A backend spec runs one table of inputs through both and requires the same answers.
 */
const INSTANT_RULE = 'must be a full ISO-8601 instant with seconds and a zone (Z or ±HH:MM); a date alone is refused';
const WINDOW_ORDER_RULE = 'must be before createdBefore';
const INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(?:Z|([+-])(\d{2}):(\d{2}))$/;

/** Epoch milliseconds, or null for anything that is not such an instant. */
function instantOf(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = INSTANT_RE.exec(value);
  if (!m) return null;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return null;
  const at = new Date(0);
  // setUTCFullYear, not Date.UTC: Date.UTC reads a year below 100 as 19xx.
  at.setUTCFullYear(year, month - 1, day);
  if (at.getUTCFullYear() !== year || at.getUTCMonth() !== month - 1 || at.getUTCDate() !== day) return null;
  at.setUTCHours(hour, minute, second, m[7] ? Number(m[7].padEnd(3, '0')) : 0);
  if (m[8] === undefined) return at.getTime();
  const offsetHours = Number(m[9]);
  const offsetMinutes = Number(m[10]);
  if (offsetHours > 23 || offsetMinutes > 59) return null;
  const offsetMs = (offsetHours * 60 + offsetMinutes) * 60000;
  return at.getTime() - (m[8] === '+' ? offsetMs : -offsetMs);
}

/** The window `[createdFrom, createdBefore)` of a list or summary, or the kernel's refusal naming the field. */
function windowOf(p: Record<string, unknown>): (recordedAt: Date) => boolean {
  const bound = (field: 'createdFrom' | 'createdBefore'): number | null =>
    p[field] === undefined ? null : (instantOf(p[field]) ?? invalid(field, INSTANT_RULE));
  const from = bound('createdFrom');
  const before = bound('createdBefore');
  if (from !== null && before !== null && from >= before) invalid('createdFrom', WINDOW_ORDER_RULE);
  return (recordedAt) =>
    (from === null || recordedAt.getTime() >= from) && (before === null || recordedAt.getTime() < before);
}

/** `Money.mulDiv` for a non-negative amount: BigInt product, ONE half-up. */
function mulDivHalfUp(amount: number, numerator: number, denominator: number): number {
  const product = BigInt(amount) * BigInt(numerator);
  const d = BigInt(denominator);
  const q = product / d;
  const r = product % d;
  const rounded = r * 2n >= d ? q + 1n : q;
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) refuse('DECK_INVOICE_INVALID_INPUT', 'amount out of range');
  return Number(rounded);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

/** Canonical JSON (sorted keys, `undefined` dropped) — what makes "the same request" comparable. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

function assertKeys(payload: unknown, allowed: Record<string, true>, field: string): Record<string, unknown> {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload))
    return invalid(field, 'must be an object');
  for (const key of Object.keys(payload as object)) {
    if (!Object.prototype.hasOwnProperty.call(allowed, key))
      invalid(`${field}.${key}`, 'is not a field of this request');
  }
  return payload as Record<string, unknown>;
}

/** The issuer-local calendar date (Asia/Kolkata), which is what "the same business day" means. */
function localDate(at: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(at);
}

interface Priced {
  lines: InvoiceComputedLine[];
  taxBreakup: InvoiceTaxBreakupEntry[];
  subtotalMinor: number;
  discountMinor: number;
  taxableMinor: number;
  taxMinor: number;
  totalMinor: number;
  documentKindCode: 'tax_invoice' | 'bill_of_supply';
  placeOfSupplyRegion: string;
  isIntraRegion: boolean;
}

/** `india-gst@1`, exclusive-price branch, regular seller — see the file header. */
function price(p: Record<string, unknown>, issuerRegion: string): Priced {
  if (p.invoiceDiscountMinor !== undefined && p.invoiceDiscountMinor !== null && p.invoiceDiscountMinor !== 0) {
    notModelled('an invoice-level discount');
  }
  const raw = p.lines;
  if (!Array.isArray(raw) || raw.length < 1) invalid('lines', 'must hold at least one line');
  const place =
    typeof p.placeOfSupplyRegion === 'string' && p.placeOfSupplyRegion ? p.placeOfSupplyRegion : issuerRegion;
  const isIntraRegion = place === issuerRegion;

  const lines = (raw as unknown[]).map((l, i): InvoiceComputedLine => {
    const lineNo = i + 1;
    const line = assertKeys(l, LINE_KEYS, `lines[${lineNo}]`);
    if (line.priceIncludesTax === true) notModelled('a tax-inclusive price');
    if (line.cessRateBp !== undefined && line.cessRateBp !== 0) notModelled('compensation cess');
    const description = typeof line.description === 'string' ? line.description.trim() : '';
    if (!description) invalid(`lines[${lineNo}].description`, 'is required');
    if (!isCount(line.quantityMilli) || line.quantityMilli <= 0)
      invalid(`lines[${lineNo}].quantityMilli`, 'must be a positive integer');
    if (!isCount(line.unitPriceMinor) || line.unitPriceMinor < 0) {
      invalid(`lines[${lineNo}].unitPriceMinor`, 'must be a non-negative integer');
    }
    if (!isCount(line.taxRateBp) || line.taxRateBp < 0 || line.taxRateBp > 10_000) {
      invalid(`lines[${lineNo}].taxRateBp`, 'must be an integer 0–10000');
    }
    const quantityMilli = line.quantityMilli as number;
    const unitPriceMinor = line.unitPriceMinor as number;
    const taxRateBp = line.taxRateBp as number;
    const grossMinor = mulDivHalfUp(unitPriceMinor, quantityMilli, 1000);
    const discountMinor = line.discountMinor === undefined ? 0 : (line.discountMinor as number);
    if (!isCount(discountMinor) || discountMinor < 0)
      invalid(`lines[${lineNo}].discountMinor`, 'must be a non-negative integer');
    if (discountMinor > grossMinor) invalid(`lines[${lineNo}].discountMinor`, 'exceeds the line amount');
    const taxableMinor = grossMinor - discountMinor;
    const gstMinor = mulDivHalfUp(taxableMinor, taxRateBp, 10_000);

    const taxes: InvoiceComputedLine['taxes'] = [];
    if (taxRateBp > 0) {
      if (isIntraRegion) {
        // allocate([1,1]): the odd paisa goes to the FIRST bucket, CGST.
        const sgst = Math.floor(gstMinor / 2);
        taxes.push({ code: 'CGST', rateBp: taxRateBp / 2, amountMinor: gstMinor - sgst });
        taxes.push({ code: 'SGST', rateBp: taxRateBp / 2, amountMinor: sgst });
      } else {
        taxes.push({ code: 'IGST', rateBp: taxRateBp, amountMinor: gstMinor });
      }
    }
    const opt = (v: unknown): string | null => (v === undefined || v === null || v === '' ? null : String(v));
    return {
      lineNo,
      description,
      hsnSac: opt(line.hsnSac),
      quantityMilli,
      unitCode: opt(line.unitCode),
      unitPriceMinor,
      grossMinor,
      discountMinor,
      taxableMinor,
      taxRateBp,
      cessRateBp: 0,
      priceIncludesTax: false,
      taxes,
      lineTotalMinor: taxableMinor + gstMinor,
      serviceDate: opt(line.serviceDate),
      sourceLineRef: opt(line.sourceLineRef)
    };
  });

  const byKey = new Map<string, InvoiceTaxBreakupEntry>();
  for (const l of lines) {
    for (const t of l.taxes) {
      const key = `${t.code}:${t.rateBp}`;
      const entry = byKey.get(key) ?? { code: t.code, rateBp: t.rateBp, taxableMinor: 0, amountMinor: 0 };
      entry.taxableMinor += l.taxableMinor;
      entry.amountMinor += t.amountMinor;
      byKey.set(key, entry);
    }
  }
  const order: InvoiceTaxComponentCode[] = ['CGST', 'SGST', 'IGST', 'CESS'];
  const taxBreakup = [...byKey.values()].sort(
    (a, b) => order.indexOf(a.code) - order.indexOf(b.code) || a.rateBp - b.rateBp
  );

  const sum = (f: (l: InvoiceComputedLine) => number) => lines.reduce((s, l) => s + f(l), 0);
  const taxableMinor = sum((l) => l.taxableMinor);
  const taxMinor = sum((l) => l.lineTotalMinor - l.taxableMinor);
  return {
    lines,
    taxBreakup,
    subtotalMinor: sum((l) => l.grossMinor),
    discountMinor: sum((l) => l.discountMinor),
    taxableMinor,
    taxMinor,
    totalMinor: taxableMinor + taxMinor,
    documentKindCode: lines.some((l) => l.taxRateBp > 0) ? 'tax_invoice' : 'bill_of_supply',
    placeOfSupplyRegion: place,
    isIntraRegion
  };
}

interface Doc {
  view: InvoiceView;
  requestHash: string;
  paid: number;
  provisional: number;
}

/** The kernel's status derivation for the states this double can reach. */
function statusOf(d: Doc): InvoiceStatusCode {
  if (d.view.statusCode === 'void') return 'void';
  const total = d.view.totals.totalMinor;
  if (d.paid >= total) return 'settled';
  if (d.paid + d.provisional >= total) return 'settled_provisional';
  if (d.paid > 0 || d.provisional > 0) return 'partly_settled';
  return 'open';
}

function balanceOf(d: Doc): InvoiceBalance {
  const total = d.view.totals.totalMinor;
  return {
    collectedMinor: d.paid,
    provisionalOpenMinor: d.provisional,
    outstandingMinor: Math.max(0, total - d.paid - d.provisional),
    refundDueMinor: Math.max(0, d.paid - total)
  };
}

/**
 * Build an in-memory ledger that behaves like `xdeck.invoice` for one package on one deck.
 * Plug it into `mockTenantRuntime({ granted, invoiceLedger })` so the capability checks and
 * the ledger behaviour are both exercised, or call it directly.
 */
export function createInMemoryInvoiceLedger(options: InMemoryInvoiceLedgerOptions = {}): InMemoryInvoiceLedger {
  const packageName = options.packageName ?? 'test/mock-package';
  const actor = options.actor ?? { kind: 'user' as const, userId: 'u-test' };
  const issuerId = options.issuer?.id ?? '00000000-0000-4000-8000-00000000d0b1';
  const issuerRegion = options.issuer?.regionCode ?? '29';
  const now = options.now ?? (() => new Date());

  const docs = new Map<string, Doc>();
  const byKey = new Map<string, string>();
  const tenders = new Map<string, { requestHash: string; result: InvoiceTenderResult }>();
  const settlementRefs = new Map<string, string>();
  // §9.166 part 12b-p — every payment recorded, in the order it was recorded, beside the invoice it belongs to.
  const paymentRows: Array<{ invoiceId: string; view: InvoicePaymentView }> = [];
  let seq = 0;
  let paymentSeq = 0;

  const requireHuman = (what: string) => {
    if (actor.kind !== 'user' || !actor.userId) {
      refuse('DECK_INVOICE_HUMAN_ACTOR_REQUIRED', `${what} must be done by a person`, { actorKind: actor.kind });
    }
  };
  const load = (invoiceId: unknown): Doc => {
    const d = typeof invoiceId === 'string' ? docs.get(invoiceId) : undefined;
    // Another package's document and a made-up id answer the same way, as in the kernel.
    return d && d.view.sourcePackage === packageName
      ? d
      : refuse('DECK_INVOICE_NOT_FOUND', 'no such invoice', { invoiceId });
  };
  const snapshot = (d: Doc): InvoiceView => {
    const statusCode = statusOf(d);
    return deepFreeze(structuredClone({ ...d.view, statusCode, balance: balanceOf(d) }) as InvoiceView);
  };
  const summaryOf = (v: InvoiceView): InvoiceSummary => {
    const { taxBreakup: _t, lines: _l, linesWithheld: _w, ...summary } = v;
    return summary;
  };
  /**
   * §9.166 part 12d-k — the one filter set `list` and `summary` share, as the kernel's: this package's documents,
   * then status, payer, scope and the window on the instant each was recorded (D-12dk-1, D-12dk-2).
   */
  const listed = (p: Record<string, unknown>): InvoiceView[] => {
    const inWindow = windowOf(p);
    const statuses = Array.isArray(p.statusCodes) ? (p.statusCodes as string[]) : null;
    return [...docs.values()]
      .filter((d) => d.view.sourcePackage === packageName)
      .map(snapshot)
      .filter((v) => (statuses ? statuses.includes(v.statusCode) : true))
      .filter((v) => (typeof p.payerLinkId === 'string' ? v.payerLinkId === p.payerLinkId : true))
      .filter((v) => (typeof p.scopeRef === 'string' ? v.scopeRef === p.scopeRef : true))
      .filter((v) => inWindow(v.createdAt));
  };

  const ledger: InMemoryInvoiceLedger = {
    async quote(payload) {
      const p = assertKeys(payload, QUOTE_KEYS, 'input');
      const priced = price(p, issuerRegion);
      const result: InvoiceQuoteResult = {
        strategyId: 'india-gst@1',
        documentKindCode: priced.documentKindCode,
        currency: 'INR',
        placeOfSupplyRegion: priced.placeOfSupplyRegion,
        isIntraRegion: priced.isIntraRegion,
        lines: priced.lines,
        taxBreakup: priced.taxBreakup,
        subtotalMinor: priced.subtotalMinor,
        discountMinor: priced.discountMinor,
        taxableMinor: priced.taxableMinor,
        taxMinor: priced.taxMinor,
        roundOffMinor: 0,
        totalMinor: priced.totalMinor,
        issuerId,
        scopeRef: typeof p.scopeRef === 'string' ? p.scopeRef : ''
      };
      return deepFreeze(structuredClone(result));
    },

    async issue(payload): Promise<InvoiceIssueResult> {
      const p = assertKeys(payload, ISSUE_KEYS, 'input');
      const key = p.idempotencyKey;
      if (typeof key !== 'string' || !INVOICE_DOUBLE_IDEMPOTENCY_KEY_RE.test(key)) {
        invalid('idempotencyKey', 'must be <scope>:<entity>:<ordinal>');
      }
      const requestHash = canonical(p);
      const prior = byKey.get(key as string);
      if (prior) {
        const d = docs.get(prior) as Doc;
        if (d.requestHash !== requestHash) {
          refuse('DECK_INVOICE_IDEMPOTENCY_MISMATCH', 'this key was used for a different request', {
            idempotencyKey: key
          });
        }
        return { invoice: snapshot(d), deduplicated: true, awaitingNumber: false };
      }
      const priced = price(p, issuerRegion);
      if (typeof p.expectTotalMinor === 'number' && p.expectTotalMinor !== priced.totalMinor) {
        refuse('DECK_INVOICE_TOTAL_MISMATCH', 'your total differs from the ledger’s', {
          expectTotalMinor: p.expectTotalMinor,
          totalMinor: priced.totalMinor
        });
      }
      seq += 1;
      const at = now();
      const id = `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
      const payer =
        p.payer && typeof p.payer === 'object' ? (p.payer as { customerLinkId: string }).customerLinkId : null;
      const view: InvoiceView = {
        id,
        number: `T/DBL-${String(seq).padStart(5, '0')}`,
        seq,
        fyLabel: 'DB',
        statusCode: 'open',
        documentKindCode: priced.documentKindCode,
        sensitivityCode: 'standard',
        currency: 'INR',
        issueDate: localDate(at),
        issuedAt: at,
        supplyAt: p.supplyAt ? new Date(p.supplyAt as string) : at,
        dueAt: p.dueAt ? new Date(p.dueAt as string) : null,
        placeOfSupplyRegion: priced.placeOfSupplyRegion,
        isIntraRegion: priced.isIntraRegion,
        scopeRef: typeof p.scopeRef === 'string' ? p.scopeRef : '',
        issuerId,
        sourcePackage: packageName,
        sourceRef: typeof p.sourceRef === 'string' ? p.sourceRef : null,
        payerLinkId: payer,
        totals: {
          subtotalMinor: priced.subtotalMinor,
          discountMinor: priced.discountMinor,
          taxableMinor: priced.taxableMinor,
          taxMinor: priced.taxMinor,
          roundOffMinor: 0,
          totalMinor: priced.totalMinor
        },
        balance: { collectedMinor: 0, provisionalOpenMinor: 0, outstandingMinor: priced.totalMinor, refundDueMinor: 0 },
        stateVersion: 1,
        createdAt: at,
        updatedAt: at,
        taxBreakup: priced.taxBreakup,
        lines: priced.lines,
        linesWithheld: false
      };
      const doc: Doc = { view, requestHash, paid: 0, provisional: 0 };
      docs.set(id, doc);
      byKey.set(key as string, id);
      return { invoice: snapshot(doc), deduplicated: false, awaitingNumber: false };
    },

    async get(payload) {
      const p = assertKeys(payload, { invoiceId: true }, 'input');
      return snapshot(load(p.invoiceId));
    },

    // §9.166 part 12b-p (D-12bp-6) — the kernel's read over what this double holds: the same view, oldest first
    // (createdAt, then id), paged by cursor. Another package's invoice and a made-up id refuse as `get` does. A limit
    // outside 1..100 is refused where the kernel clamps it, as this double's `list` refuses outside 1..200.
    async payments(payload): Promise<InvoicePaymentsResult> {
      const p = assertKeys(payload, PAYMENTS_KEYS, 'input');
      const d = load(p.invoiceId);
      const limit = p.limit === undefined ? 50 : (p.limit as number);
      if (!isCount(limit) || limit < 1 || limit > PAYMENTS_PAGE_MAX)
        invalid('limit', 'must be an integer from 1 to 100');
      const mine = paymentRows
        .filter((row) => row.invoiceId === d.view.id)
        .map((row) => row.view)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const start = typeof p.cursor === 'string' ? mine.findIndex((v) => v.id === p.cursor) + 1 : 0;
      if (typeof p.cursor === 'string' && start === 0) invalid('cursor', 'is not one this ledger issued');
      const page = mine.slice(start, start + limit);
      const more = start + limit < mine.length;
      return deepFreeze(structuredClone({ items: page, nextCursor: more ? page[page.length - 1].id : null }));
    },

    async list(payload = {}): Promise<InvoiceListResult> {
      const p = assertKeys(payload, LIST_KEYS, 'input');
      const limit = p.limit === undefined ? 50 : (p.limit as number);
      if (!isCount(limit) || limit < 1 || limit > 200) invalid('limit', 'must be an integer from 1 to 200');
      const mine = listed(p).sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0));
      const start = typeof p.cursor === 'string' ? mine.findIndex((v) => v.id === p.cursor) + 1 : 0;
      if (typeof p.cursor === 'string' && start === 0) invalid('cursor', 'is not one this ledger issued');
      const page = mine.slice(start, start + limit);
      const more = start + limit < mine.length;
      return deepFreeze({ items: page.map(summaryOf), nextCursor: more ? page[page.length - 1].id : null });
    },

    async recordTender(payload): Promise<InvoiceTenderResult> {
      requireHuman('recording money received');
      const p = assertKeys(payload, TENDER_KEYS, 'input');
      const key = p.idempotencyKey;
      if (typeof key !== 'string' || !INVOICE_DOUBLE_IDEMPOTENCY_KEY_RE.test(key)) {
        invalid('idempotencyKey', 'must be <scope>:<entity>:<ordinal>');
      }
      const requestHash = canonical(p);
      const replay = tenders.get(key as string);
      if (replay) {
        if (replay.requestHash !== requestHash) {
          refuse('DECK_INVOICE_IDEMPOTENCY_MISMATCH', 'this key was used for a different tender', {
            idempotencyKey: key
          });
        }
        return deepFreeze({ ...replay.result, deduplicated: true });
      }
      const kind = typeof p.tenderKindCode === 'string' ? INVOICE_DOUBLE_TENDER_KINDS[p.tenderKindCode] : undefined;
      if (!kind) invalid('tenderKindCode', 'must be an offline tender kind');
      const tender = kind as (typeof INVOICE_DOUBLE_TENDER_KINDS)[string];
      if (!isCount(p.amountMinor) || (p.amountMinor as number) <= 0)
        invalid('amountMinor', 'must be a positive integer');
      const ref = typeof p.externalRef === 'string' && p.externalRef.trim() ? p.externalRef.trim() : null;
      if (tender.requiresExternalRef && !ref) {
        refuse('DECK_INVOICE_EXTERNAL_REF_REQUIRED', 'this tender needs its reference', {
          tenderKindCode: p.tenderKindCode
        });
      }
      const d = load(p.invoiceId);
      const status = statusOf(d);
      if (!['open', 'partly_settled', 'settled_provisional'].includes(status)) {
        refuse('DECK_INVOICE_NOT_OPEN', 'this invoice is not open for payment', {
          invoiceId: d.view.id,
          statusCode: status
        });
      }
      const settlementKey = tender.refIsSettlementKey && ref ? `${p.tenderKindCode}:${ref}` : null;
      if (settlementKey && settlementRefs.has(settlementKey) && settlementRefs.get(settlementKey) !== d.view.id) {
        refuse('DECK_INVOICE_EXTERNAL_REF_ALREADY_USED', 'this reference already settled another invoice', {
          tenderKindCode: p.tenderKindCode
        });
      }
      const amount = p.amountMinor as number;
      if (amount > balanceOf(d).outstandingMinor) {
        refuse('DECK_INVOICE_OVER_APPLICATION', 'that is more than this invoice still owes, so nothing was recorded', {
          invoiceId: d.view.id,
          amountMinor: amount,
          provisional: tender.provisionalUntilReconciled
        });
      }
      if (tender.provisionalUntilReconciled) d.provisional += amount;
      else d.paid += amount;
      d.view = { ...d.view, stateVersion: d.view.stateVersion + 1, updatedAt: now() };
      if (settlementKey) settlementRefs.set(settlementKey, d.view.id);
      paymentSeq += 1;
      const result: InvoiceTenderResult = {
        paymentId: `00000000-0000-4000-9000-${String(paymentSeq).padStart(12, '0')}`,
        invoiceId: d.view.id,
        amountMinor: amount,
        provisional: tender.provisionalUntilReconciled,
        invoiceStatusCode: statusOf(d),
        deduplicated: false
      };
      tenders.set(key as string, { requestHash, result });
      const recordedAt = now();
      paymentRows.push({
        invoiceId: d.view.id,
        view: {
          id: result.paymentId,
          tenderKindCode: p.tenderKindCode as string,
          amountMinor: amount,
          currency: d.view.currency,
          statusCode: tender.provisionalUntilReconciled ? 'provisional' : 'captured',
          gateway: null,
          refundedMinor: 0,
          refundPendingMinor: 0,
          createdAt: recordedAt,
          capturedAt: tender.provisionalUntilReconciled ? null : recordedAt
        }
      });
      return deepFreeze({ ...result });
    },

    async void(payload): Promise<InvoiceClosureResult> {
      requireHuman('voiding an invoice');
      const p = assertKeys(payload, VOID_KEYS, 'input');
      if (typeof p.reasonCode !== 'string' || !INVOICE_DOUBLE_VOID_REASONS.includes(p.reasonCode)) {
        invalid('reasonCode', 'must be a void reason');
      }
      const d = load(p.invoiceId);
      if (d.view.statusCode === 'void') {
        return deepFreeze({
          invoiceId: d.view.id,
          number: d.view.number,
          statusCode: 'void',
          reasonCode: p.reasonCode as string,
          deduplicated: true
        });
      }
      if (d.paid > 0 || d.provisional > 0) {
        refuse('DECK_INVOICE_VOID_NOT_ALLOWED', 'an invoice with payments cannot be voided — credit it instead', {
          invoiceId: d.view.id,
          reason: 'touched'
        });
      }
      if (d.view.issueDate !== localDate(now())) {
        refuse('DECK_INVOICE_VOID_NOT_ALLOWED', 'an invoice can only be voided on the day it was issued', {
          invoiceId: d.view.id,
          reason: 'window_closed'
        });
      }
      // The number stays consumed: a voided document is cancelled, never erased.
      d.view = { ...d.view, statusCode: 'void', stateVersion: d.view.stateVersion + 1, updatedAt: now() };
      return deepFreeze({
        invoiceId: d.view.id,
        number: d.view.number,
        statusCode: 'void',
        reasonCode: p.reasonCode as string,
        deduplicated: false
      });
    },

    async changes() {
      return notModelled('invoice.changes');
    },
    /**
     * §9.166 part 12d-k — per currency, over the documents the list's filters keep (the window included), with the
     * kernel's figures. `limit` and `cursor` are accepted and do nothing, as in the kernel. What this double cannot
     * reach stays zero: `creditedMinor` (no credit note) and every refund or reconciliation.
     */
    async summary(payload = {}): Promise<InvoiceSummaryRow[]> {
      const p = assertKeys(payload, LIST_KEYS, 'input');
      const byCurrency = new Map<string, InvoiceSummaryRow>();
      for (const v of listed(p)) {
        const row = byCurrency.get(v.currency) ?? {
          currency: v.currency,
          documentCount: 0,
          totalMinor: 0,
          collectedMinor: 0,
          provisionalOpenMinor: 0,
          creditedMinor: 0,
          outstandingMinor: 0
        };
        row.documentCount += 1;
        row.totalMinor += v.totals.totalMinor;
        row.collectedMinor += v.balance.collectedMinor;
        row.provisionalOpenMinor += v.balance.provisionalOpenMinor;
        row.outstandingMinor += v.balance.outstandingMinor;
        byCurrency.set(v.currency, row);
      }
      return deepFreeze([...byCurrency.values()].sort((a, b) => (a.currency < b.currency ? -1 : 1)));
    },
    async reconcileTender() {
      return notModelled('invoice.reconcileTender');
    },
    async credit() {
      return notModelled('invoice.credit (credit notes)');
    },
    async recordOfflineRefund() {
      return notModelled('invoice.recordOfflineRefund');
    },
    async collectOnline() {
      return notModelled('invoice.collectOnline (online money)');
    },
    async confirmPayment() {
      return notModelled('invoice.confirmPayment (online money)');
    },
    async refund() {
      // §9.166 cluster 6 — a GATEWAY refund needs a gateway, a captured initiation and the deck's
      // own credentials. A double that pretended to send money back would let a vertical's tests
      // pass over a path that only exists on the cloud, which is the drift this double exists to
      // prevent. `recordOfflineRefund` is the same refusal for the same reason.
      return notModelled('invoice.refund (gateway money out)');
    },

    __documents() {
      return [...docs.values()].filter((d) => d.view.sourcePackage === packageName).map(snapshot);
    }
  };
  return ledger;
}
