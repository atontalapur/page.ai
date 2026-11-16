# Twilio paging

The orchestrator pages on-call by phone call and SMS through Twilio (#31). This page sets up
the trial account, verifies the team's four phones and checks that a page reaches each one
(#127).

## Trial limits

From Twilio's [trial restrictions](https://www.twilio.com/docs/usage/trials):

- Calls and texts reach verified numbers only, five at most. The number you sign up with is
  verified automatically.
- An SMS body must be one of Twilio's template names, such as `sms_internal_alerts`. The
  orchestrator's own page text (class and dashboard link) is rejected, so on trial a page
  arrives as a call only. Each phone has its own notify job: a failed call retries that phone
  alone, and once its call goes through, a failed text is logged without calling it again.
- Calls can speak custom text with `<Say>`, so the call still names the class.
- Answering machine detection works on trial. The orchestrator turns it on, so a call that
  voicemail picks up counts as not answered and that phone is called again. The message
  plays after the beep, so the voicemail holds all of it. On a paid account Twilio bills each
  detection; set `TWILIO_MACHINE_DETECTION=false` to turn it off, or if Twilio rejects it.
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

## 2. Verify the other three phones

In the Console, open **Verified Caller IDs** and add each remaining phone in E.164 form
(`+1` and ten digits). Twilio calls or texts that phone with a code, and its owner reads the
code back to whoever is at the Console. One phone at a time.

## 3. Railway

Set these on the `orchestrator` service in the `extraordinary-presence` project:

| Variable             | Value                                     |
| -------------------- | ----------------------------------------- |
| `TWILIO_ACCOUNT_SID` | Account SID                               |
| `TWILIO_AUTH_TOKEN`  | Auth Token                                |
| `TWILIO_FROM_NUMBER` | Trial number, E.164                       |
| `NOTIFY_TO_NUMBERS`  | The four verified phones, comma-separated |
| `USE_FAKE_ADAPTERS`  | `false`                                   |

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
railway run --service orchestrator pnpm --filter @page/orchestrator page:test --sms-body sms_internal_alerts
```

Without the CLI, put the four values in the repo's `.env` and drop the `railway run
--service orchestrator` prefix.

This places one call and sends one SMS to every number in `NOTIFY_TO_NUMBERS` through the
same adapter and config parser the orchestrator uses. It prints one line per phone and
channel, with only the last four digits of any number, and exits 1 if Twilio rejected any
of them. A call line says `sent` only once a person picks up; busy or no answer shows as
`FAILED call no-answer`, and voicemail as `FAILED call answered by machine_end_beep`. Calls go one phone at a time, so answer each as it rings. #127 is
done when all eight lines say `sent` and every phone got the text. Paste the output into the
issue.

After an upgrade, drop `--sms-body` to send the script's own text instead of a template.
