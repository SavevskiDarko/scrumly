/**
 * The fixtures are dated around a sprint that starts 2026-09-14, and the
 * burndown checks assume "today" falls inside it. Run the clock as if the suite
 * started on 2026-09-25 so those dates don't expire. It still ticks, so events
 * recorded one after another keep their order.
 */
const RealDate = Date
const offset = new RealDate('2026-09-25T12:00:00').getTime() - RealDate.now()

class ShiftedDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(RealDate.now() + offset)
    else super(...(args as ConstructorParameters<typeof Date>))
  }

  static now() {
    return RealDate.now() + offset
  }
}

globalThis.Date = ShiftedDate as DateConstructor
