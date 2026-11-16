/**
 * §9.166 Step 6 chunk 5C2 — the in-memory invoice double behaves like the ledger for the
 * flows a vertical exercises, and refuses with the kernel's codes. Its ARITHMETIC is pinned
 * to the real `india-gst@1` calculator by a backend spec (invoice-double-parity.spec.ts);
 * this spec pins its BEHAVIOUR.
 */
import { CapabilityNotGrantedError } from './errors';
import { INVOICE_DOUBLE_NOT_MODELLED, createInMemoryInvoiceLedger } from './invoice-double';
import { mockTenantRuntime } from './testing';

const dosa = { description: 'Masala dosa', quantityMilli: 1000, unitPriceMinor: 12000, taxRateBp: 500 };
const issueReq = (key: string, over: Record<string, unknown> = {}) => ({ idempotencyKey: key, lines: [dosa], ...over });

async function refusal(fn: () => Promise<unknown>): Promise<{ code?: string; details?: Record<string, unknown> }> {
  try {
    await fn();
    return {};
  } catch (e) {
    const err = e as { code?: string; details?: Record<string, unknown> };
    return { code: err.code, details: err.details };
  }
}

describe('invoice double — issuing', () => {
  it('numbers gaplessly, visibly not a tax invoice, and prices 5% GST intra-state to the paisa', async () => {
    const ledger = createInMemoryInvoiceLedger();
    const a = await ledger.issue(issueReq('bill:1:1'));
    const b = await ledger.issue(issueReq('bill:1:2'));
    expect([a.invoice.number, b.invoice.number]).toEqual(['T/DBL-00001', 'T/DBL-00002']);
    expect(a.invoice.totals).toEqual({
      subtotalMinor: 12000,
      discountMinor: 0,
      taxableMinor: 12000,
      taxMinor: 600,
      roundOffMinor: 0,
      totalMinor: 12600
    });
    expect(a.invoice.taxBreakup).toEqual([
      { code: 'CGST', rateBp: 250, taxableMinor: 12000, amountMinor: 300 },
      { code: 'SGST', rateBp: 250, taxableMinor: 12000, amountMinor: 300 }
    ]);
    expect(a.invoice.statusCode).toBe('open');
  });

  it('an inter-state supply is IGST, and the odd paisa of an intra-state split goes to CGST', async () => {
    const ledger = createInMemoryInvoiceLedger();
    const inter = await ledger.issue(issueReq('bill:2:1', { placeOfSupplyRegion: '27' }));
    expect(inter.invoice.taxBreakup.map((t) => t.code)).toEqual(['IGST']);
    // 101 paise at 5% = 5.05 → 5 paise of GST: CGST 3, SGST 2.
    const odd = await ledger.issue(issueReq('bill:2:2', { lines: [{ ...dosa, unitPriceMinor: 101 }] }));
    expect(odd.invoice.lines?.[0].taxes).toEqual([
      { code: 'CGST', rateBp: 250, amountMinor: 3 },
      { code: 'SGST', rateBp: 250, amountMinor: 2 }
    ]);
  });

  it('the same key and request replays the same document; a different request is refused', async () => {
    const ledger = createInMemoryInvoiceLedger();
    const first = await ledger.issue(issueReq('bill:3:1'));
    const again = await ledger.issue(issueReq('bill:3:1'));
    expect(again).toEqual({ ...first, deduplicated: true });
    // A replay consumes no number.
    expect((await ledger.issue(issueReq('bill:3:2'))).invoice.number).toBe('T/DBL-00002');
    expect(
      await refusal(() => ledger.issue(issueReq('bill:3:1', { lines: [{ ...dosa, unitPriceMinor: 99 }] })))
    ).toEqual(expect.objectContaining({ code: 'DECK_INVOICE_IDEMPOTENCY_MISMATCH' }));
  });

  it('refuses a malformed key, and any field the kernel does not accept — naming it', async () => {
    const ledger = createInMemoryInvoiceLedger();
    expect((await refusal(() => ledger.issue(issueReq('not-a-key')))).details?.field).toBe('idempotencyKey');
    for (const smuggled of ['deckId', 'deckEnv', 'sourcePackage', 'number', 'statusCode']) {
      const r = await refusal(() => ledger.issue({ ...issueReq('bill:4:1'), [smuggled]: 'x' }));
      expect({ smuggled, code: r.code, field: r.details?.field }).toEqual({
        smuggled,
        code: 'DECK_INVOICE_INVALID_INPUT',
        field: `input.${smuggled}`
      });
    }
  });

  it('refuses when the caller’s own total disagrees, handing back the ledger’s', async () => {
    const ledger = createInMemoryInvoiceLedger();
    const r = await refusal(() => ledger.issue(issueReq('bill:5:1', { expectTotalMinor: 12500 })));
    expect(r).toEqual({ code: 'DECK_INVOICE_TOTAL_MISMATCH', details: { expectTotalMinor: 12500, totalMinor: 12600 } });
  });

  it('an issued document cannot be edited — not through the returned object, not in the store', async () => {
    const ledger = createInMemoryInvoiceLedger();
    const { invoice } = await ledger.issue(issueReq('bill:6:1'));
    expect(() => {
      (invoice.totals as { totalMinor: number }).totalMinor = 1;
    }).toThrow(TypeError);
    expect((await ledger.get({ invoiceId: invoice.id })).totals.totalMinor).toBe(12600);
  });
});

describe('invoice double — money in', () => {
  it('a partial cash payment is partly settled; the rest settles it', async () => {
    const ledger = createInMemoryInvoiceLedger();
    const { invoice } = await ledger.issue(issueReq('bill:7:1'));
    const part = await ledger.recordTender({
      invoiceId: invoice.id,
      tenderKindCode: 'cash',
      amountMinor: 6000,
      idempotencyKey: 'pay:7:1'
    });
    expect(part).toEqual(expect.objectContaining({ provisional: false, invoiceStatusCode: 'partly_settled' }));
    const rest = await ledger.recordTender({
      invoiceId: invoice.id,
      tenderKindCode: 'cash',
      amountMinor: 6600,
      idempotencyKey: 'pay:7:2'
    });
    expect(rest.invoiceStatusCode).toBe('settled');
    expect((await ledger.get({ invoiceId: invoice.id })).balance).toEqual({
      collectedMinor: 12600,
      provisionalOpenMinor: 0,
      outstandingMinor: 0,
      refundDueMinor: 0
    });
  });

  it('paying more than is owed records NOTHING', async () => {
    const ledger = createInMemoryInvoiceLedger();
    const { invoice } = await ledger.issue(issueReq('bill:8:1'));
    expect(
      (
        await refusal(() =>
          ledger.recordTender({
            invoiceId: invoice.id,
            tenderKindCode: 'cash',
            amountMinor: 12601,
            idempotencyKey: 'pay:8:1'
          })
        )
      ).code
    ).toBe('DECK_INVOICE_OVER_APPLICATION');
    expect((await ledger.get({ invoiceId: invoice.id })).balance.collectedMinor).toBe(0);
  });

  it('a cheque is money-shaped but provisional, and needs its reference', async () => {
    const ledger = createInMemoryInvoiceLedger();
    const { invoice } = await ledger.issue(issueReq('bill:9:1'));
    expect(
      (
        await refusal(() =>
          ledger.recordTender({
            invoiceId: invoice.id,
            tenderKindCode: 'cheque',
            amountMinor: 12600,
            idempotencyKey: 'pay:9:1'
          })
        )
      ).code
    ).toBe('DECK_INVOICE_EXTERNAL_REF_REQUIRED');
    const chq = await ledger.recordTender({
      invoiceId: invoice.id,
      tenderKindCode: 'cheque',
      amountMinor: 12600,
      externalRef: 'CHQ-100231',
      idempotencyKey: 'pay:9:2'
    });
    expect(chq).toEqual(expect.objectContaining({ provisional: true, invoiceStatusCode: 'settled_provisional' }));
  });

  it('one UPI reference settles ONE invoice', async () => {
    const ledger = createInMemoryInvoiceLedger();
    const a = (await ledger.issue(issueReq('bill:10:1'))).invoice;
    const b = (await ledger.issue(issueReq('bill:10:2'))).invoice;
    await ledger.recordTender({
      invoiceId: a.id,
      tenderKindCode: 'upi_external',
      amountMinor: 100,
      externalRef: 'UPI-77',
      idempotencyKey: 'pay:10:1'
    });
    expect(
      (
        await refusal(() =>
          ledger.recordTender({
            invoiceId: b.id,
            tenderKindCode: 'upi_external',
            amountMinor: 100,
            externalRef: 'UPI-77',
            idempotencyKey: 'pay:10:2'
          })
        )
      ).code
    ).toBe('DECK_INVOICE_EXTERNAL_REF_ALREADY_USED');
  });

  it('a tender replay is deduplicated; the same key for a different tender is refused', async () => {
    const ledger = createInMemoryInvoiceLedger();
    const { invoice } = await ledger.issue(issueReq('bill:11:1'));
    const args = { invoiceId: invoice.id, tenderKindCode: 'cash', amountMinor: 100, idempotencyKey: 'pay:11:1' };
    const first = await ledger.recordTender(args);
    expect(await ledger.recordTender(args)).toEqual({ ...first, deduplicated: true });
    expect((await refusal(() => ledger.recordTender({ ...args, amountMinor: 200 }))).code).toBe(
      'DECK_INVOICE_IDEMPOTENCY_MISMATCH'
    );
    // …and the replay moved no money.
    expect((await ledger.get({ invoiceId: invoice.id })).balance.collectedMinor).toBe(100);
  });

  it('no unattended cash: a system or device caller cannot record a tender', async () => {
    for (const kind of ['system', 'device'] as const) {
      const ledger = createInMemoryInvoiceLedger({ actor: { kind, userId: null } });
      const { invoice } = await ledger.issue(issueReq('bill:12:1'));
      expect(
        (
          await refusal(() =>
            ledger.recordTender({
              invoiceId: invoice.id,
              tenderKindCode: 'cash',
              amountMinor: 100,
              idempotencyKey: 'pay:12:1'
            })
          )
        ).code
      ).toBe('DECK_INVOICE_HUMAN_ACTOR_REQUIRED');
    }
  });

  it('a gateway tender is not an offline tender, and an unknown invoice is not found', async () => {
    const ledger = createInMemoryInvoiceLedger();
    const { invoice } = await ledger.issue(issueReq('bill:13:1'));
    expect(
      (
        await refusal(() =>
          ledger.recordTender({
            invoiceId: invoice.id,
            tenderKindCode: 'gateway_online',
            amountMinor: 100,
            idempotencyKey: 'pay:13:1'
          })
        )
      ).details?.field
    ).toBe('tenderKindCode');
    expect(
      (
        await refusal(() =>
          ledger.recordTender({
            invoiceId: 'nope',
            tenderKindCode: 'cash',
            amountMinor: 100,
            idempotencyKey: 'pay:13:2'
          })
        )
      ).code
    ).toBe('DECK_INVOICE_NOT_FOUND');
  });
});

describe('invoice double — void', () => {
  it('an untouched invoice voids the same day, and keeps its number', async () => {
    const ledger = createInMemoryInvoiceLedger();
    const { invoice } = await ledger.issue(issueReq('bill:14:1'));
    const v = await ledger.void({ invoiceId: invoice.id, reasonCode: 'entered_in_error' });
    expect(v).toEqual({
      invoiceId: invoice.id,
      number: 'T/DBL-00001',
      statusCode: 'void',
      reasonCode: 'entered_in_error',
      deduplicated: false
    });
    expect((await ledger.void({ invoiceId: invoice.id, reasonCode: 'entered_in_error' })).deduplicated).toBe(true);
    // A voided invoice takes no money.
    expect(
      (
        await refusal(() =>
          ledger.recordTender({
            invoiceId: invoice.id,
            tenderKindCode: 'cash',
            amountMinor: 1,
            idempotencyKey: 'pay:14:1'
          })
        )
      ).code
    ).toBe('DECK_INVOICE_NOT_OPEN');
  });

  it('a touched invoice, or one from another day, cannot be voided — saying which', async () => {
    let clock = new Date('2026-09-22T05:00:00.000Z');
    const ledger = createInMemoryInvoiceLedger({ now: () => clock });
    const touched = (await ledger.issue(issueReq('bill:15:1'))).invoice;
    await ledger.recordTender({
      invoiceId: touched.id,
      tenderKindCode: 'cash',
      amountMinor: 1,
      idempotencyKey: 'pay:15:1'
    });
    expect((await refusal(() => ledger.void({ invoiceId: touched.id, reasonCode: 'duplicate' }))).details?.reason).toBe(
      'touched'
    );

    const yesterday = (await ledger.issue(issueReq('bill:15:2'))).invoice;
    clock = new Date('2026-09-23T05:00:00.000Z');
    expect(
      (await refusal(() => ledger.void({ invoiceId: yesterday.id, reasonCode: 'duplicate' }))).details?.reason
    ).toBe('window_closed');
  });

  it('voiding needs a person and a void reason', async () => {
    const auto = createInMemoryInvoiceLedger({ actor: { kind: 'system' } });
    const a = (await auto.issue(issueReq('bill:16:1'))).invoice;
    expect((await refusal(() => auto.void({ invoiceId: a.id, reasonCode: 'duplicate' }))).code).toBe(
      'DECK_INVOICE_HUMAN_ACTOR_REQUIRED'
    );
    const human = createInMemoryInvoiceLedger();
    const b = (await human.issue(issueReq('bill:16:2'))).invoice;
    expect((await refusal(() => human.void({ invoiceId: b.id, reasonCode: 'sales_return' }))).details?.field).toBe(
      'reasonCode'
    );
  });
});

describe('invoice double — reading', () => {
  it('lists newest first, pages by cursor, and filters by status', async () => {
    const ledger = createInMemoryInvoiceLedger();
    for (let i = 1; i <= 3; i += 1) await ledger.issue(issueReq(`bill:17:${i}`));
    const first = await ledger.list({ limit: 2 });
    expect(first.items.map((i) => i.number)).toEqual(['T/DBL-00003', 'T/DBL-00002']);
    const second = await ledger.list({ limit: 2, cursor: first.nextCursor as string });
    expect(second.items.map((i) => i.number)).toEqual(['T/DBL-00001']);
    expect(second.nextCursor).toBeNull();
    // A summary carries no lines — the list never hands over a document's contents.
    expect(Object.keys(first.items[0])).not.toContain('lines');
    expect((await ledger.list({ statusCodes: ['void'] })).items).toEqual([]);
  });
});

describe('invoice double — what it will not pretend to know', () => {
  it.each([
    ['a tax-inclusive price', { lines: [{ ...dosa, priceIncludesTax: true }] }],
    ['compensation cess', { lines: [{ ...dosa, cessRateBp: 1200 }] }],
    ['an invoice-level discount', { invoiceDiscountMinor: 100 }]
  ])('refuses %s by name rather than approximating it', async (branch, over) => {
    const ledger = createInMemoryInvoiceLedger();
    expect(await refusal(() => ledger.issue(issueReq('bill:18:1', over)))).toEqual({
      code: INVOICE_DOUBLE_NOT_MODELLED,
      details: { branch }
    });
  });

  it('refuses the unmodelled methods by name', async () => {
    const ledger = createInMemoryInvoiceLedger();
    for (const call of [
      () => ledger.credit({ invoiceId: 'i', reasonCode: 'x', lines: [], idempotencyKey: 'c:1:1' }),
      () =>
        ledger.collectOnline({
          invoiceId: 'i',
          amountMinor: 1,
          gateway: 'razorpay',
          returnUrl: 'https://d.test/r',
          idempotencyKey: 'k'
        }),
      () => ledger.reconcileTender({ paymentId: 'p', outcome: 'confirmed', source: 'manual' })
    ]) {
      expect((await refusal(call)).code).toBe(INVOICE_DOUBLE_NOT_MODELLED);
    }
  });
});

describe('invoice double inside mockTenantRuntime — keys first, then the ledger', () => {
  it('a granted method reaches the ledger; an ungranted one never does', async () => {
    const ledger = createInMemoryInvoiceLedger();
    const xd = mockTenantRuntime({ granted: ['invoice:issue'], invoiceLedger: ledger });
    const { invoice } = await xd.invoice.issue(issueReq('bill:19:1'));
    expect(invoice.number).toBe('T/DBL-00001');
    expect(() =>
      xd.invoice.recordTender({
        invoiceId: invoice.id,
        tenderKindCode: 'cash',
        amountMinor: 100,
        idempotencyKey: 'pay:19:1'
      })
    ).toThrow(CapabilityNotGrantedError);
    expect(ledger.__documents()[0].balance.collectedMinor).toBe(0);
  });

  it('collectOnline passes BOTH keys, then the ledger says it does not model online money', async () => {
    const xd = mockTenantRuntime({
      granted: ['invoice:settle', 'payment:initiate'],
      invoiceLedger: createInMemoryInvoiceLedger()
    });
    expect(
      (
        await refusal(
          () =>
            xd.invoice.collectOnline({
              invoiceId: 'i',
              amountMinor: 1,
              gateway: 'razorpay',
              returnUrl: 'https://d.test/r',
              idempotencyKey: 'k'
            }) as Promise<unknown>
        )
      ).code
    ).toBe(INVOICE_DOUBLE_NOT_MODELLED);
  });
});

describe('invoice double — the payments of one invoice (§9.166 part 12b-p)', () => {
  // The kernel's view, key for key and in order (pinned against PAYMENT_VIEW_KEYS by the backend's payments spec).
  const VIEW_KEYS = [
    'id',
    'tenderKindCode',
    'amountMinor',
    'currency',
    'statusCode',
    'gateway',
    'refundedMinor',
    'refundPendingMinor',
    'createdAt',
    'capturedAt'
  ];

  it('lists only THAT invoice’s payments, oldest first, in the kernel’s view and nothing more', async () => {
    let tick = Date.parse('2026-11-14T06:00:00.000Z');
    const ledger = createInMemoryInvoiceLedger({ now: () => new Date((tick += 1000)) });
    const { invoice: a } = await ledger.issue(issueReq('bill:20:1'));
    const { invoice: b } = await ledger.issue(issueReq('bill:20:2'));
    const cash = { invoiceId: a.id, tenderKindCode: 'cash', amountMinor: 5000, idempotencyKey: 'pay:20:1' };
    await ledger.recordTender(cash);
    await ledger.recordTender({
      invoiceId: b.id,
      tenderKindCode: 'cash',
      amountMinor: 700,
      idempotencyKey: 'pay:20:2'
    });
    await ledger.recordTender({
      invoiceId: a.id,
      tenderKindCode: 'cheque',
      amountMinor: 3000,
      externalRef: 'CHQ-000123',
      idempotencyKey: 'pay:20:3'
    });
    // An identical retry answers the first payment and lists nothing new.
    expect((await ledger.recordTender(cash)).deduplicated).toBe(true);

    const page = await ledger.payments({ invoiceId: a.id });
    expect(page.nextCursor).toBeNull();
    expect(page.items.map((p) => [p.tenderKindCode, p.amountMinor, p.statusCode])).toEqual([
      ['cash', 5000, 'captured'],
      ['cheque', 3000, 'provisional']
    ]);
    expect(page.items.map((p) => Object.keys(p))).toEqual([VIEW_KEYS, VIEW_KEYS]);
    expect(page.items[0]).toEqual(
      expect.objectContaining({ currency: 'INR', gateway: null, refundedMinor: 0, refundPendingMinor: 0 })
    );
    expect(page.items[0].capturedAt).toEqual(page.items[0].createdAt);
    expect(page.items[1].capturedAt).toBeNull();
    // No reference and no key reaches the view.
    expect(JSON.stringify(page)).not.toContain('CHQ-000123');
    expect(JSON.stringify(page)).not.toContain('pay:20');
    expect((await ledger.payments({ invoiceId: b.id })).items.map((p) => p.amountMinor)).toEqual([700]);
  });

  it('pages by cursor, oldest first, payments of one instant falling to the id', async () => {
    const instant = new Date('2026-11-14T06:00:00.000Z');
    const ledger = createInMemoryInvoiceLedger({ now: () => instant });
    const { invoice } = await ledger.issue(issueReq('bill:21:1'));
    for (let n = 1; n <= 5; n += 1) {
      await ledger.recordTender({
        invoiceId: invoice.id,
        tenderKindCode: 'cash',
        amountMinor: 100 * n,
        idempotencyKey: `pay:21:${n}`
      });
    }
    const seen: number[] = [];
    const sizes: number[] = [];
    let cursor: string | undefined;
    do {
      const page = await ledger.payments({ invoiceId: invoice.id, limit: 2, ...(cursor ? { cursor } : {}) });
      sizes.push(page.items.length);
      seen.push(...page.items.map((p) => p.amountMinor));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(sizes).toEqual([2, 2, 1]);
    expect(seen).toEqual([100, 200, 300, 400, 500]);
  });

  it.each([0, 101, 1.5])('refuses a limit of %p — a page holds 1 to 100', async (limit) => {
    const ledger = createInMemoryInvoiceLedger();
    const { invoice } = await ledger.issue(issueReq('bill:22:1'));
    expect(await refusal(() => ledger.payments({ invoiceId: invoice.id, limit }))).toEqual({
      code: 'DECK_INVOICE_INVALID_INPUT',
      details: { field: 'limit', rule: 'must be an integer from 1 to 100' }
    });
  });

  it('a made-up id refuses exactly as get does; an unknown cursor or field is refused, never read as page one', async () => {
    const ledger = createInMemoryInvoiceLedger();
    const { invoice } = await ledger.issue(issueReq('bill:24:1'));
    const madeUp = '00000000-0000-4000-8000-000000000999';
    const asPayments = await refusal(() => ledger.payments({ invoiceId: madeUp }));
    expect(asPayments.code).toBe('DECK_INVOICE_NOT_FOUND');
    expect(asPayments).toEqual(await refusal(() => ledger.get({ invoiceId: madeUp })));
    expect((await refusal(() => ledger.payments({ invoiceId: invoice.id, cursor: 'nope' }))).code).toBe(
      'DECK_INVOICE_INVALID_INPUT'
    );
    expect((await refusal(() => ledger.payments({ invoiceId: invoice.id, scopeRef: 'outlet-b' } as never))).code).toBe(
      'DECK_INVOICE_INVALID_INPUT'
    );
  });

  it('inside mockTenantRuntime it needs invoice:read, and the settle key alone is not enough', async () => {
    const ledger = createInMemoryInvoiceLedger();
    const { invoice } = await ledger.issue(issueReq('bill:23:1'));
    const reader = mockTenantRuntime({ granted: ['invoice:read'], invoiceLedger: ledger });
    expect(await reader.invoice.payments({ invoiceId: invoice.id })).toEqual({ items: [], nextCursor: null });
    const settler = mockTenantRuntime({ granted: ['invoice:settle'], invoiceLedger: ledger });
    expect(() => settler.invoice.payments({ invoiceId: invoice.id })).toThrow(CapabilityNotGrantedError);
  });
});

describe('invoice double — a window on the instant an invoice was recorded (§9.166 part 12d-k)', () => {
  const INSTANT_RULE = 'must be a full ISO-8601 instant with seconds and a zone (Z or ±HH:MM); a date alone is refused';

  /** Three bills recorded at 06:00, 07:00 and 08:00 UTC on 2026-11-14 (11:30, 12:30 and 13:30 in India). */
  async function threeBills() {
    let clock = new Date('2026-11-14T06:00:00.000Z');
    const ledger = createInMemoryInvoiceLedger({ now: () => clock });
    const ids: string[] = [];
    for (const instant of ['2026-11-14T06:00:00.000Z', '2026-11-14T07:00:00.000Z', '2026-11-14T08:00:00.000Z']) {
      clock = new Date(instant);
      ids.push((await ledger.issue(issueReq(`bill:30:${ids.length + 1}`))).invoice.id);
    }
    const setClock = (instant: string) => {
      clock = new Date(instant);
    };
    return { ledger, ids, setClock };
  }
  const numbers = (page: { items: Array<{ number: string | null }> }) => page.items.map((i) => i.number);

  it('keeps createdFrom <= recorded < createdBefore; either bound alone; an offset is the same instant', async () => {
    const { ledger } = await threeBills();
    expect(numbers(await ledger.list({ createdFrom: '2026-11-14T07:00:00Z' }))).toEqual(['T/DBL-00003', 'T/DBL-00002']);
    expect(numbers(await ledger.list({ createdBefore: '2026-11-14T07:00:00Z' }))).toEqual(['T/DBL-00001']);
    expect(
      numbers(await ledger.list({ createdFrom: '2026-11-14T06:00:00.000Z', createdBefore: '2026-11-14T08:00:00.000Z' }))
    ).toEqual(['T/DBL-00002', 'T/DBL-00001']);
    // 12:30 in India is 07:00 UTC.
    expect(
      numbers(
        await ledger.list({ createdFrom: '2026-11-14T12:30:00+05:30', createdBefore: '2026-11-14T12:30:00.001+05:30' })
      )
    ).toEqual(['T/DBL-00002']);
  });

  it('summary aggregates only the window, with the figures the list’s documents carry', async () => {
    const { ledger, ids, setClock } = await threeBills();
    setClock('2026-11-14T07:30:00.000Z');
    await ledger.recordTender({
      invoiceId: ids[1],
      tenderKindCode: 'cash',
      amountMinor: 5000,
      idempotencyKey: 'pay:30:1'
    });
    await ledger.recordTender({
      invoiceId: ids[1],
      tenderKindCode: 'cheque',
      amountMinor: 1000,
      externalRef: 'CHQ-000301',
      idempotencyKey: 'pay:30:2'
    });
    const row = (over: Record<string, number>) => ({
      currency: 'INR',
      documentCount: 0,
      totalMinor: 0,
      collectedMinor: 0,
      provisionalOpenMinor: 0,
      creditedMinor: 0,
      outstandingMinor: 0,
      ...over
    });
    expect(
      await ledger.summary({ createdFrom: '2026-11-14T07:00:00Z', createdBefore: '2026-11-14T08:00:00Z' })
    ).toEqual([
      row({
        documentCount: 1,
        totalMinor: 12600,
        collectedMinor: 5000,
        provisionalOpenMinor: 1000,
        outstandingMinor: 6600
      })
    ]);
    expect(await ledger.summary({ createdFrom: '2026-11-14T07:00:00Z' })).toEqual([
      row({
        documentCount: 2,
        totalMinor: 25200,
        collectedMinor: 5000,
        provisionalOpenMinor: 1000,
        outstandingMinor: 19200
      })
    ]);
    expect(await ledger.summary({ createdBefore: '2026-11-14T07:00:00Z' })).toEqual([
      row({ documentCount: 1, totalMinor: 12600, outstandingMinor: 12600 })
    ]);
    expect(await ledger.summary()).toEqual([
      row({
        documentCount: 3,
        totalMinor: 37800,
        collectedMinor: 5000,
        provisionalOpenMinor: 1000,
        outstandingMinor: 31800
      })
    ]);
    // Nothing recorded in the window: no rows, not a refusal.
    expect(await ledger.summary({ createdFrom: '2026-11-15T00:00:00+05:30' })).toEqual([]);
  });

  it.each<[string, 'createdFrom' | 'createdBefore', unknown]>([
    ['a date alone', 'createdFrom', '2026-11-14'],
    ['no zone', 'createdFrom', '2026-11-14T00:00:00'],
    ['no seconds', 'createdBefore', '2026-11-14T00:00Z'],
    ['a day that does not exist', 'createdBefore', '2026-02-30T00:00:00Z'],
    ['hour 24', 'createdFrom', '2026-11-14T24:00:00Z'],
    ['finer than a millisecond', 'createdFrom', '2026-11-14T00:00:00.123456Z'],
    ['an epoch number', 'createdBefore', 1763078400000],
    ['null', 'createdFrom', null]
  ])('refuses %s in %s by name, on list and summary alike', async (_what, field, value) => {
    const { ledger } = await threeBills();
    const expected = { code: 'DECK_INVOICE_INVALID_INPUT', details: { field, rule: INSTANT_RULE } };
    expect(await refusal(() => ledger.list({ [field]: value } as never))).toEqual(expected);
    expect(await refusal(() => ledger.summary({ [field]: value } as never))).toEqual(expected);
  });

  it('refuses a window whose start is not before its end — an empty window is a mistake, not “no invoices”', async () => {
    const { ledger } = await threeBills();
    for (const [createdFrom, createdBefore] of [
      ['2026-11-14T07:00:00Z', '2026-11-14T07:00:00Z'],
      ['2026-11-14T08:00:00Z', '2026-11-14T12:30:00+05:30']
    ]) {
      const expected = {
        code: 'DECK_INVOICE_INVALID_INPUT',
        details: { field: 'createdFrom', rule: 'must be before createdBefore' }
      };
      expect(await refusal(() => ledger.list({ createdFrom, createdBefore }))).toEqual(expected);
      expect(await refusal(() => ledger.summary({ createdFrom, createdBefore }))).toEqual(expected);
    }
  });

  it('summary refuses an unknown field; changes stays not modelled', async () => {
    const { ledger } = await threeBills();
    expect((await refusal(() => ledger.summary({ issuedFrom: '2026-11-14T00:00:00Z' } as never))).code).toBe(
      'DECK_INVOICE_INVALID_INPUT'
    );
    expect((await refusal(() => ledger.changes({ createdFrom: '2026-11-14T00:00:00Z' }))).code).toBe(
      INVOICE_DOUBLE_NOT_MODELLED
    );
  });

  it('inside mockTenantRuntime the windowed summary needs invoice:read', async () => {
    const { ledger } = await threeBills();
    const reader = mockTenantRuntime({ granted: ['invoice:read'], invoiceLedger: ledger });
    const day = await reader.invoice.summary({
      createdFrom: '2026-11-14T07:00:00Z',
      createdBefore: '2026-11-14T08:00:00Z'
    });
    expect(day.map((r) => r.documentCount)).toEqual([1]);
    const issuer = mockTenantRuntime({ granted: ['invoice:issue'], invoiceLedger: ledger });
    expect(() => issuer.invoice.summary({ createdFrom: '2026-11-14T07:00:00Z' })).toThrow(CapabilityNotGrantedError);
  });
});
