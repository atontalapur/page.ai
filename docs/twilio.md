# Twilio paging

The orchestrator pages on-call by phone call and SMS through Twilio (#31). This page sets up
the trial account, pages one on-call phone and checks that a page reaches it (#127).

## Trial limits

From Twilio's [trial restrictions](https://www.twilio.com/docs/usage/trials):

- Calls and texts reach verified numbers only, five at most. The number you sign up with is
  verified automatically.
- Calls and texts use Twilio's templates only. A create-call request may carry just `To` and
  one of Twilio's template URLs, and a text one of its template bodies such as
  `sms_internal_alerts` ("Try out Voice" and "Try out SMS" in Twilio's docs). Anything else,
  such as our own spoken message (`Twiml`), a `From` number or `MachineDetection`, fails with
  `400 ... trial accounts have limited parameter access`. So set `TWILIO_TRIAL=true` on a
  trial account: the call plays Twilio's sample speech and the text is its alert template.
  The phone still rings and gets a text, but neither names the issue; open the dashboard.
- Answering machine detection needs a paid account, so it stays off on trial. After an
  upgrade, set `TWILIO_MACHINE_DETECTION=true`: voicemail then counts as not answered and
  that phone is called again, with the message played after the beep. Twilio bills each
  detection.
- The trial ends 30 days after sign-up. Voice has 75 minutes in total, 10 per call.
- Calls and texts stay inside the sign-up country.
- Twilio assigns the trial number, and it can differ between voice and SMS. If the test call
  works but the test SMS fails on its `From` number, the account has two numbers. Note it on
  #31, since the orchestrator takes one `TWILIO_FROM_NUMBER`.

Upgrading lifts these limits. Texting US phones from a paid number then needs that number
registered first: A2P 10DLC for a local number, or toll-free verification for a toll-free
one.

## 1. Account and number

1. Sign up at twilio.com with one teammate's phone. That phone is verified.
2. In the Console, note the Account SID, the Auth Token and the trial phone number.

## 2. One phone on the trial

The trial pages the phone you signed up with, the only one it has verified. We could not
verify a second phone on this trial: the Console offered no way, and the API refuses
verification calls on trial accounts (Twilio error 10002). After an upgrade, calls reach any
number without verification, so more on-call phones are just more `NOTIFY_TO_NUMBERS`
entries.

## 3. Railway

Set these on the `orchestrator` service in the `extraordinary-presence` project:

| Variable             | Value                     |
| -------------------- | ------------------------- |
| `TWILIO_ACCOUNT_SID` | Account SID               |
| `TWILIO_AUTH_TOKEN`  | Auth Token                |
| `TWILIO_FROM_NUMBER` | Trial number, E.164       |
| `NOTIFY_TO_NUMBERS`  | The sign-up phone, E.164  |
| `TWILIO_TRIAL`       | `true` while on the trial |
| `USE_FAKE_ADAPTERS`  | `false`                   |

The orchestrator keeps the fake pager, which records pages instead of sending them, while
`USE_FAKE_ADAPTERS` is on, while the three Twilio settings are unset, or while
`NOTIFY_TO_NUMBERS` is empty. Setting only one or two of the three stops startup with a
config error. Turning `USE_FAKE_ADAPTERS` off also switches triage to
OpenRouter, which uses the `OPENROUTER_API_KEY` already set there.

The Auth Token is not in `.env.shared` (`pnpm env:pull`), and stays out of it: it can call
and text from the account. Keep it in Railway and in the `.env` of whoever runs the test.

## 4. Test

Run it with Railway's values, so it tests exactly what the orchestrator uses and no secret
lands in a local file (needs the Railway CLI, logged in and linked to the project):

```sh
railway run --service orchestrator pnpm --filter @page/orchestrator page:test
```

Without the CLI, put the four values in the repo's `.env` and drop the `railway run
--service orchestrator` prefix.

This places one call and sends one SMS to every number in `NOTIFY_TO_NUMBERS` through the
same adapter and config parser the orchestrator uses. It prints one line per phone and
channel, with only the last four digits of any number, and exits 1 if Twilio rejected any
of them. A call line says `sent` only once a person picks up; busy or no answer shows as
`FAILED call no-answer`. With detection on (paid accounts), voicemail shows as `FAILED call
answered by machine_end_beep`. Calls go one phone at a time, so answer each as it rings.
#127 is done when both lines say `sent` and the phone got the text. Paste the output into
the issue.

With `TWILIO_TRIAL=true` the call and the text are Twilio's templates. After an upgrade, turn
it off: the call then speaks the script's own message and `--sms-body <text>` sets the
text.
