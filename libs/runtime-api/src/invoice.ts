/**
 * §9.166 Step 6 — `xdeck.invoice`: the typed surface a package codes against to bill a
 * deck's own customers through the core ledger.
 *
 * ── Why these types live here and not in the backend ─────────────────────────
 * A vertical's repo (`xdeck-pkg-restroin-core`, `xdeck-pkg-clinicloud-billing`) must build
 * and test WITHOUT the platform backend — that is the independent-development rule for
 * sibling repos. So the contract is stated here, and a BACKEND spec
 * (`invoice-sdk-parity.spec.ts`) pins it to the kernel in both directions: every result
 * type here must be assignable from the kernel's and back, and every payload's keys must
 * equal the ledger DTO's accepted-key list. A kernel change that would silently break a
 * vertical therefore breaks a compile first.
 *
 * ── What a payload can never carry ───────────────────────────────────────────
 * No deck, environment, package, version, actor, number, status or amount-paid. The
 * kernel takes all of those from the verified call and REFUSES a payload that names one,
 * so they are absent from these types rather than optional in them.
 *
 * ── Two keys, and ship-dark ──────────────────────────────────────────────────
 * Every call needs the package's `invoice:*` capability AND the acting person's
 * `deck_invoices:*` permission. The capabilities are catalogued but not yet grantable to
 * any deck (owner decision 19); a package may declare them and test against
 * `mockTenantRuntime` today.
 *
 * Money is integer minor units, quantities are thousandths, rates are basis points —
 * nowhere a float. Timestamps are `Date`: results cross the sandbox by structured clone.
 */

export type InvoiceStatusCode =
  | 'awaiting_number'
  | 'open'
  | 'partly_settled'
  | 'settled_provisional'
  | 'settled'
  | 'credited'
  | 'void'
  | 'written_off';

export type InvoiceDocumentKindCode = 'tax_invoice' | 'bill_of_supply' | 'plain_invoice';
export type InvoiceTaxComponentCode = 'CGST' | 'SGST' | 'IGST' | 'CESS';

/** Who is billed: an anonymous counter sale, or a deck-local customer link. Never a name or phone. */
export type InvoicePayer = 'walk_in' | { customerLinkId: string };

// ── payloads ────────────────────────────────────────────────────────────────

/** One line as the package prices it. The kernel decides the tax split and the document kind. */
export interface InvoiceLineDraft {
  description: string;
  hsnSac?: string | null;
  /** Thousandths of a unit: 1500 = 1.5. */
  quantityMilli: number;
  unitCode?: string | null;
  unitPriceMinor: number;
  discountMinor?: number;
  taxRateBp: number;
  cessRateBp?: number;
  /** True ⇒ `unitPriceMinor` is the shelf price including tax; the kernel back-calculates. */
  priceIncludesTax?: boolean;
  /** `YYYY-MM-DD`. */
  serviceDate?: string | null;
  sourceLineRef?: string | null;
}

export interface InvoiceQuotePayload {
  /** '' or absent = the deck-wide seller; otherwise the outlet/facility this sale belongs to. */
  scopeRef?: string;
  payer?: InvoicePayer | null;
  placeOfSupplyRegion?: string | null;
  lines: InvoiceLineDraft[];
  invoiceDiscountMinor?: number;
}

export interface InvoiceIssuePayload extends InvoiceQuotePayload {
  /** `<ns>:<purpose>:<n>`, taken byte for byte. The same key with a different request is refused. */
  idempotencyKey: string;
  sourceRef?: string | null;
  supplyAt?: Date | string | null;
  dueAt?: Date | string | null;
  /** Your own total. A mismatch refuses and hands back the kernel's figures. */
  expectTotalMinor?: number | null;
}

export interface InvoiceGetPayload {
  invoiceId: string;
}

/**
 * Keyset pages only. Record scope comes from the caller's grants and cannot be set here.
 *
 * §9.166 part 12d-k — `createdFrom` and `createdBefore` bound the instant the ledger RECORDED the invoice:
 * `createdFrom <= createdAt < createdBefore`. Each is a full ISO-8601 instant with seconds and a zone, `Z` or
 * `±HH:MM`, at most milliseconds (`2026-11-14T00:00:00+05:30`); either may be given alone. A date alone is refused:
 * a day's boundaries are your own calendar, never the server's, so compute them where you know the zone. A malformed
 * instant, a date that does not exist, or a window whose start is not before its end is refused
 * `DECK_INVOICE_INVALID_INPUT` naming the field. `list`, `changes` and `summary` all take it (on `changes` it
 * keeps the invoices recorded in the window); it only ever narrows what your package and your grants already see.
 */
export interface InvoiceListPayload {
  limit?: number;
  cursor?: string;
  statusCodes?: InvoiceStatusCode[];
  payerLinkId?: string;
  scopeRef?: string;
  /** Inclusive start of the window on the recording instant. */
  createdFrom?: string;
  /** Exclusive end of the window on the recording instant. */
  createdBefore?: string;
}

/**
 * §9.166 part 12b-p — one invoice's payments, oldest first. The invoice is read through the same walls as `get`
 * (your package's own, inside your record scope), so a foreign or out-of-scope id answers exactly as `get` does.
 * `limit` defaults to 50 and is at most 100; `cursor` is the `nextCursor` of the page before.
 */
export interface InvoicePaymentsPayload {
  invoiceId: string;
  limit?: number;
  cursor?: string;
}

export interface InvoiceRecordTenderPayload {
  invoiceId: string;
  /** A seeded offline tender: `cash`, `upi_external`, `card_terminal`, `bank_transfer`, `cheque`, `voucher`. */
  tenderKindCode: string;
  amountMinor: number;
  /** Required for tenders that carry a reference (a UPI id, a cheque number). */
  externalRef?: string | null;
  idempotencyKey: string;
}

export interface InvoiceReconcileTenderPayload {
  paymentId: string;
  outcome: 'confirmed' | 'failed';
  source: 'manual' | 'gateway' | 'reconciler';
  failureCode?: string | null;
}

export interface InvoiceVoidPayload {
  invoiceId: string;
  reasonCode: string;
  reasonText?: string | null;
}

export interface InvoiceCreditPayload {
  invoiceId: string;
  reasonCode: string;
  reasonText?: string | null;
  lines: Array<{ lineNo: number; taxableAmountMinor: number }>;
  idempotencyKey: string;
}

export interface InvoiceOfflineRefundPayload {
  paymentId: string;
  amountMinor: number;
  tenderKindCode: string;
  reasonCode: string;
  reasonText?: string | null;
  /** When the refund is the money side of a credit note on the same invoice. */
  creditNoteId?: string | null;
  idempotencyKey: string;
}

/**
 * §9.166 cluster 6 — start collecting online money against an invoice.
 *
 * Five fields, and no more: how much of this invoice to collect now, which of the deck's connected
 * accounts to use, and where the payer lands afterwards. The currency, the payer, what the money
 * does to the invoice and which payment row it becomes are the LEDGER's — a caller that could name
 * them could collect one invoice's money against another's balance.
 */
export interface InvoiceCollectOnlinePayload {
  invoiceId: string;
  amountMinor: number;
  gateway: 'razorpay' | 'phonepe';
  /** https only, no embedded credentials — a payer is redirected here mid-payment. */
  returnUrl: string;
  idempotencyKey: string;
}

/** Pull the gateway's word on one in-flight collection. */
export interface InvoiceConfirmPaymentPayload {
  paymentId: string;
}

/**
 * §9.166 cluster 6 — a GATEWAY refund. The account is NOT a field: the money goes back through the
 * one that captured it, resolved from the collection inside the kernel.
 */
export interface InvoiceGatewayRefundPayload {
  paymentId: string;
  amountMinor: number;
  tenderKindCode: string;
  reasonCode: string;
  reasonText?: string | null;
  creditNoteId?: string | null;
  idempotencyKey: string;
}

// ── results ─────────────────────────────────────────────────────────────────

export interface InvoiceLineTax {
  code: InvoiceTaxComponentCode;
  /** Display only. CGST/SGST carry HALF the slab, so 0.25% GST shows 12.5. */
  rateBp: number;
  amountMinor: number;
}

export interface InvoiceComputedLine {
  lineNo: number;
  description: string;
  hsnSac: string | null;
  quantityMilli: number;
  unitCode: string | null;
  unitPriceMinor: number;
  grossMinor: number;
  /** Line discount PLUS this line's share of the invoice discount. */
  discountMinor: number;
  taxableMinor: number;
  taxRateBp: number;
  cessRateBp: number;
  priceIncludesTax: boolean;
  taxes: InvoiceLineTax[];
  lineTotalMinor: number;
  serviceDate: string | null;
  sourceLineRef: string | null;
}

export interface InvoiceTaxBreakupEntry {
  code: InvoiceTaxComponentCode;
  rateBp: number;
  taxableMinor: number;
  amountMinor: number;
}

export interface InvoiceTotals {
  subtotalMinor: number;
  discountMinor: number;
  taxableMinor: number;
  taxMinor: number;
  roundOffMinor: number;
  totalMinor: number;
}

export interface InvoiceBalance {
  /** Money actually in hand: paid − refunded. */
  collectedMinor: number;
  /** Recorded but not yet confirmed (a cheque, an unreconciled UPI reference). */
  provisionalOpenMinor: number;
  /** What the customer still owes, counting provisional money as if it will clear. Never negative. */
  outstandingMinor: number;
  /** What the business owes BACK — a credit note against a paid invoice lands here. */
  refundDueMinor: number;
}

export interface InvoiceSummary {
  id: string;
  /** Null only while a box-born document waits for its number. */
  number: string | null;
  seq: number | null;
  fyLabel: string | null;
  statusCode: InvoiceStatusCode;
  documentKindCode: string;
  sensitivityCode: string;
  currency: string;
  issueDate: string | null;
  issuedAt: Date | null;
  supplyAt: Date;
  dueAt: Date | null;
  placeOfSupplyRegion: string;
  isIntraRegion: boolean;
  scopeRef: string;
  issuerId: string;
  sourcePackage: string;
  sourceRef: string | null;
  payerLinkId: string | null;
  totals: InvoiceTotals;
  balance: InvoiceBalance;
  stateVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface InvoiceView extends InvoiceSummary {
  taxBreakup: InvoiceTaxBreakupEntry[];
  /** Null ONLY when withheld — `linesWithheld` says which, so "empty" is never ambiguous. */
  lines: InvoiceComputedLine[] | null;
  linesWithheld: boolean;
}

export interface InvoiceQuoteResult {
  strategyId: string;
  documentKindCode: InvoiceDocumentKindCode;
  currency: string;
  placeOfSupplyRegion: string;
  isIntraRegion: boolean;
  lines: InvoiceComputedLine[];
  taxBreakup: InvoiceTaxBreakupEntry[];
  subtotalMinor: number;
  discountMinor: number;
  taxableMinor: number;
  taxMinor: number;
  roundOffMinor: number;
  totalMinor: number;
  issuerId: string;
  scopeRef: string;
}

export interface InvoiceIssueResult {
  invoice: InvoiceView;
  /** True when this call returned an invoice an earlier call with the same key created. */
  deduplicated: boolean;
  /** True only for a box-born row that has no number yet. */
  awaitingNumber: boolean;
}

export interface InvoiceListResult {
  items: InvoiceSummary[];
  nextCursor: string | null;
}

/**
 * How a payment stands, derived by the ledger from the payment's own columns:
 * `captured` — money taken (a tender recorded as paid, a confirmed reference, a captured online payment);
 * `provisional` — recorded, its reference not yet confirmed (a cheque, a UPI, card or bank reference);
 * `pending` — an online payment in flight, neither captured nor failed;
 * `failed` — a reference rejected at reconciliation, or an online payment that failed or expired.
 */
export type InvoicePaymentStatusCode = 'captured' | 'provisional' | 'pending' | 'failed';

/**
 * One payment as a package sees it: what it can show and what it can refund. No reference, gateway reference,
 * idempotency key, recording user or reconciliation detail: a reference is personal data, and the key is your own.
 */
export interface InvoicePaymentView {
  id: string;
  tenderKindCode: string;
  amountMinor: number;
  currency: string;
  statusCode: InvoicePaymentStatusCode;
  /** The gateway an online payment is bound to; null for money taken at the counter (and before the binding). */
  gateway: string | null;
  refundedMinor: number;
  /** Reserved for a gateway refund in flight; released if that refund fails. */
  refundPendingMinor: number;
  createdAt: Date;
  capturedAt: Date | null;
}

export interface InvoicePaymentsResult {
  items: InvoicePaymentView[];
  nextCursor: string | null;
}

export interface InvoiceSummaryRow {
  currency: string;
  documentCount: number;
  totalMinor: number;
  collectedMinor: number;
  provisionalOpenMinor: number;
  creditedMinor: number;
  outstandingMinor: number;
}

export interface InvoiceTenderResult {
  paymentId: string;
  invoiceId: string;
  amountMinor: number;
  /** True when this tender is money-shaped but not yet money. */
  provisional: boolean;
  invoiceStatusCode: string;
  deduplicated: boolean;
}

export interface InvoiceReconcileResult {
  paymentId: string;
  invoiceId: string;
  outcome: 'confirmed' | 'failed';
  invoiceStatusCode: string;
  reviewItemId: string | null;
  deduplicated: boolean;
}

export interface InvoiceClosureResult {
  invoiceId: string;
  /** Reported, not removed — a voided document is cancelled, never erased. */
  number: string | null;
  statusCode: string;
  reasonCode: string;
  deduplicated: boolean;
}

export interface InvoiceCreditNoteResult {
  creditNoteId: string;
  invoiceId: string;
  number: string;
  totalMinor: number;
  taxableMinor: number;
  taxMinor: number;
  /** False once the CGST s.34(2) window has closed — the document stands, the tax does not reverse. */
  carriesTaxReversal: boolean;
  invoiceStatusCode: string;
  deduplicated: boolean;
}

export interface InvoiceCollectOnlineResult {
  paymentId: string;
  invoiceId: string;
  amountMinor: number;
  gateway: string;
  /** The gateway-side ref this collection is bound to; null until the binding lands. */
  gatewayRef: string | null;
  /** Where to send the payer; null when the gateway returned none. */
  redirectUrl: string | null;
  deduplicated: boolean;
}

export interface InvoiceConfirmPaymentResult {
  paymentId: string;
  /** True when THIS call moved the invoice's counters. */
  applied: boolean;
  status: 'captured' | 'pending' | 'failed';
  /** True when the capture had already been applied (by the webhook or the reconciler). */
  alreadyApplied: boolean;
}

export interface InvoiceRefundResult {
  refundId: string;
  paymentId: string;
  invoiceId: string;
  amountMinor: number;
  appliedPortionMinor: number;
  outcome: 'reserved' | 'succeeded' | 'failed';
  invoiceStatusCode: string | null;
  reviewItemId: string | null;
  deduplicated: boolean;
}

/**
 * `xdeck.invoice` — every method refuses with a stable `err.code` rather than returning
 * an empty answer ("refused is not empty").
 *
 * §9.166 cluster 6 has landed, so the three online methods are now typed for real:
 * `collectOnline` records the payment in flight BEFORE the gateway is called, `confirmPayment`
 * pulls the gateway's word through the same applier the webhook uses, and `refund` sends money back
 * through the account that captured it. The last one needs `payment:refund` as well as
 * `invoice:credit` — taking money and giving it back are different grants — and all three refuse on
 * an appliance, which holds no gateway keys.
 */
export interface InvoiceAPI {
  quote(payload: InvoiceQuotePayload): Promise<InvoiceQuoteResult>;
  issue(payload: InvoiceIssuePayload): Promise<InvoiceIssueResult>;
  get(payload: InvoiceGetPayload): Promise<InvoiceView>;
  list(payload?: InvoiceListPayload): Promise<InvoiceListResult>;
  changes(payload?: InvoiceListPayload): Promise<InvoiceListResult>;
  /** Per currency, aggregated by the ledger; give a window (see {@link InvoiceListPayload}) for one day's figures. */
  summary(payload?: InvoiceListPayload): Promise<InvoiceSummaryRow[]>;
  /** §9.166 part 12b-p — the payments of one invoice, oldest first (see {@link InvoicePaymentsPayload}). */
  payments(payload: InvoicePaymentsPayload): Promise<InvoicePaymentsResult>;
  recordTender(payload: InvoiceRecordTenderPayload): Promise<InvoiceTenderResult>;
  reconcileTender(payload: InvoiceReconcileTenderPayload): Promise<InvoiceReconcileResult>;
  void(payload: InvoiceVoidPayload): Promise<InvoiceClosureResult>;
  credit(payload: InvoiceCreditPayload): Promise<InvoiceCreditNoteResult>;
  recordOfflineRefund(payload: InvoiceOfflineRefundPayload): Promise<InvoiceRefundResult>;
  collectOnline(payload: InvoiceCollectOnlinePayload): Promise<InvoiceCollectOnlineResult>;
  confirmPayment(payload: InvoiceConfirmPaymentPayload): Promise<InvoiceConfirmPaymentResult>;
  refund(payload: InvoiceGatewayRefundPayload): Promise<InvoiceRefundResult>;
}
