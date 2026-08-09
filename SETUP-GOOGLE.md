# Connecting Google Calendar and Drive

This is the one part I cannot do for you — it involves your Google account, and
you should be the one clicking through it. It takes about ten minutes, once.

You are creating a personal OAuth client so **your** copy of the app can talk to
**your** Google account. Nothing is shared with anyone.

---

## Before you start

Have your GitHub Pages address ready if you have already deployed (it looks like
`https://fergalicious123.github.io`). If you have not deployed yet, do this setup with
just the localhost origin and come back to add the live one later — step 5
explains where.

---

## 1. Create a project

1. Go to **https://console.cloud.google.com/**
2. Sign in with the Google account whose calendar you want to use.
3. Click the project dropdown in the top bar → **New Project**.
4. Name it `Daily Organizer` → **Create**.
5. Wait for the notification, then make sure that project is selected in the top bar.

## 2. Turn on the two APIs

1. Left menu → **APIs & Services** → **Library**.
2. Search **Google Calendar API** → click it → **Enable**.
3. Go back to Library, search **Google Drive API** → click it → **Enable**.

Both must be enabled. The app uses Calendar for events and Drive for the file
holding your tasks.

## 3. Configure the consent screen

1. **APIs & Services** → **OAuth consent screen**.
2. User type: **External** → **Create**.
   (External sounds wrong for personal use, but Internal is only available to
   Google Workspace organisations. External + Testing is the correct choice for
   a personal project.)
3. Fill in the required fields only:
   - App name: `Daily Organizer`
   - User support email: your email
   - Developer contact email: your email
4. **Save and Continue** through Scopes (nothing to add here — the app requests
   its scopes at sign-in time).
5. On **Test users**, click **Add Users** and add your own Google address.
   This matters: in Testing mode only listed test users can sign in.
6. **Save and Continue** → **Back to Dashboard**.

Leave the publishing status as **Testing**. See the note at the bottom about
what that means day to day.

## 4. Create the OAuth client ID

1. **APIs & Services** → **Credentials** → **Create Credentials** → **OAuth client ID**.
2. Application type: **Web application**.
3. Name: `Organizer web client`.
4. Under **Authorized JavaScript origins**, click **Add URI** for each of these:

   ```
   http://localhost:8000
   ```
   ```
   https://fergalicious123.github.io
   ```

   **Origins are scheme + host + port only** — no path, no trailing slash.
   Even though the app lives at
   `https://fergalicious123.github.io/daily-organizer/`, the origin you register
   is just `https://fergalicious123.github.io`. Getting this wrong is the single
   most common reason sign-in fails with "invalid_client".

5. Leave **Authorized redirect URIs** empty. The app uses the token flow, which
   does not use redirects.
6. **Create**.

## 5. Connect the app

**If this is Ben's copy, the Client ID is already built in** — open
**Settings** (bottom of the sidebar) and it is filled in for you. Just click
**Connect Google**.

**If you forked this**, Google showed you a Client ID ending in
`.apps.googleusercontent.com` when you created the credential. Copy it, then in
the organizer go to **Settings** → **OAuth Client ID** → paste over the
built-in one → **Connect Google**.

(The built-in ID is committed on purpose. Browser OAuth clients have no secret,
and the authorized-origins list is what actually restricts it — so it is
useless from any domain that is not on that list. Shipping it means a phone
install works without thumb-typing 72 characters.)

A Google sign-in window opens. Because the app is in Testing mode you will see
a warning screen — click **Advanced**, then **Go to Daily Organizer (unsafe)**.
This is expected for a personal, unverified app. It is your own project talking
to your own account.

Grant the two permissions it asks for, and the sidebar's sync indicator turns
green.

Once connected, reopen Settings and pick which calendar to sync from the
dropdown.

---

## What it does with each permission

| Permission | Why | Scope |
|---|---|---|
| See and edit your calendars | Two-way sync of events and reminders | `calendar` |
| See and edit files it creates in Drive | Stores `organizer-data.json` — your tasks, lists and history | `drive.file` |

`drive.file` gives the app access **only to the one file it creates**. It cannot
see the rest of your Drive.

---

## Adding the GitHub Pages origin later

If you set this up before deploying, come back after:
**Credentials** → click your OAuth client → **Add URI** under Authorized
JavaScript origins → `https://fergalicious123.github.io` → **Save**.

Changes can take a few minutes to take effect.

---

## Things that go wrong

**"invalid_client" or "The Client ID is not valid for this address"**
The address you are using is not in the authorized origins list. Check for a
trailing slash or a path — it must be exactly `http://localhost:8000`, not
`http://localhost:8000/` or `http://127.0.0.1:8000`. `localhost` and `127.0.0.1`
are different origins to Google.

**"Access blocked: this app has not completed verification"**
You are not on the test users list. Go back to the OAuth consent screen and add
your address under Test users.

**The sign-in popup is blocked**
Allow popups for the site. The token flow needs a popup on first consent.

**It worked yesterday and today it asks me to sign in again**
Normal. Access tokens last about an hour and the app refreshes them silently in
the background. If you have been away long enough for consent to lapse, click
the sync indicator to reconnect. In Testing mode Google also expires consent
periodically — see below.

**Nothing syncs and the indicator is red**
Click it — it opens Settings and shows the actual error message rather than
hiding it.

---

## A note on "Testing" mode

Keeping the app in Testing is the right call for personal use: no verification
process, no review, works immediately. The trade-offs:

- You see the "unverified app" warning at sign-in (click through it).
- Only addresses on the test-user list can sign in.
- Google may require you to re-consent every so often. It takes two clicks.

You do not need to publish or verify the app for it to work indefinitely.
