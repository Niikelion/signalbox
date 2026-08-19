# @signalbox/schedule

signalbox plugin: schedule one-shot and cron jobs, timezone-aware, via [Croner](https://github.com/hexagon/croner).

Part of [signalbox](https://github.com/Niikelion/signalbox) — see the [full documentation](https://github.com/Niikelion/signalbox/tree/master/docs).

## Install

```bash
npm install @signalbox/schedule
```

## Usage

```ts
import { schedulePlugin } from "@signalbox/schedule"

const plugins = {
    schedule: schedulePlugin(),
}

// in a workflow:
ctx.plugins.schedule.cron("0 9 * * 1", { timezone: "Europe/Warsaw" }, () => {
    ctx.log("Monday 9am")
})

ctx.plugins.schedule.at(new Date(Date.now() + 60_000), () => {
    ctx.log("one minute later")
})
```

- **`cron(expression, options, fn)`** — run on a cron schedule; `options.timezone` is an IANA zone (defaults to host local time).
- **`at(date, fn)`** — run once at a date (a past date never fires).
- **`next(expression, options?, from?)`** — the next run at or after `from`, or `null`.

Each returns a `ScheduleHandle` you can stop; jobs are torn down with the app.

## License

MIT
