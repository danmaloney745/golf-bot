# golf-bot

Books the weekend tee time at Craddockstown on BRS when bookings open on **Monday at 19:16** (Dublin time). It tries slots from **07:20** onwards, earliest first, and moves to the next free slot if one fails.

## How it works (AWS, eu-west-1)

- **Availability page**: a Lambda function URL serves the page and its small API. Dan, Mark and Hugh tick Sat/Sun. The ticks are stored in DynamoDB, one item per weekend. The link needs `?k=<PAGE_KEY>`.
- **Booking**: EventBridge Scheduler starts the booking Lambda at **19:10 Europe/Dublin** every Monday. It logs in, reads the ticks 30 seconds before opening, and books at 19:16. The result shows on the page under each weekend.
- **Screenshots and logs** of every run go to an S3 bucket, kept for 30 days.

Bookings go through Dan's BRS account, so a day is only booked if Dan has ticked it. A failed run is never retried automatically.

## Setup

Add these repo secrets under **Settings → Secrets and variables → Actions**:

| Secret | What |
| --- | --- |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | IAM user that can deploy CloudFormation/SAM stacks |
| `BRS_USERNAME`, `BRS_PASSWORD` | BRS login. The deploy copies them into SSM SecureString parameters |
| `PAGE_KEY` | Any phrase. It's the `?k=` on the page link |

Every push to `main` deploys. The run summary prints the page link.

## Testing

**Actions → Test run → Run workflow**:

- `recon`: logs in and captures the tee sheet and booking form. Books nothing.
- `dry-run`: picks a slot and fills in the players, but never presses confirm.

Screenshots land on the `runs` branch.

Tee times, opening time and player names live in `src/config.json`.
