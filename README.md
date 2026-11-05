# golf-bot

Books the Saturday/Sunday tee time at Craddockstown on BRS when bookings open on **Monday at 19:16** (Dublin time). It tries every slot from **07:20** onwards, earliest first, and moves to the next free slot if one fails.

## How a week runs

1. Dan, Mark and Hugh tick Sat/Sun on the availability page.
2. Monday ~18:55: a Claude scheduled task copies the ticks into `availability.json` and pushes it.
3. Monday 16:30 UTC: the GitHub Action starts, logs in a few minutes before 19:16, pulls the latest `availability.json`, and books each day for whoever ticked it.
4. The run summary says what was booked; screenshots of every step are saved as a run artifact for 14 days.

Bookings go through Dan's BRS account, so a day is only booked if Dan has ticked it. The bot refuses to book if `availability.json` isn't for the right weekend.

## Setup

Repo **Settings → Secrets and variables → Actions**, add:

- `BRS_USERNAME`: your BRS username or membership number
- `BRS_PASSWORD`: your BRS password

## Testing

**Actions → Book tee time → Run workflow**:

- `recon`: logs in, saves the tee sheet and the booking form. Books nothing.
- `dry-run`: does everything except press the final confirm button.
- `book`: a real booking.

Settings like the earliest tee time live in `config.json`.
