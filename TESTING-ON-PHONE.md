# Testing the mobile experience

Three ways to do it, in increasing fidelity. Start at the top — the first one
needs nothing and catches most problems.

---

## 1. Your touchscreen laptop (nothing to set up)

Narrow the browser window until the layout flips to the phone arrangement — the
bottom tab bar appears at under 760px wide. Then **use the screen, not the
trackpad**.

This is better than DevTools device emulation for the things most likely to
break, because it is genuine touch input rather than a simulation of it.

Worth exercising specifically:

- **Long-press a task and drag it onto an hour** in Day view. It should lift
  after about a third of a second, follow your finger, and highlight the slot
  underneath.
- **Scroll a list by dragging.** It should scroll, not pick up a task. Getting
  this boundary wrong is the usual way touch drag becomes infuriating.
- **Tap a task.** Should open the editor, not start a drag.
- **Completed → "Move to a day"** on a row. Also try long-press dragging one
  onto a date in Month view.
- The **clock widget** in the bottom-right: does it sit clear of the tab bar?

---

## 2. Your real phone, over Wi-Fi

The dev server already listens on every network interface, so no changes are
needed. From your phone's browser, go to:

> **http://10.112.158.32:8000**

(That was the laptop's Wi-Fi address when this was written. If it stops
working, the address has changed — find the current one by running
`ipconfig` and reading the IPv4 address under your Wi-Fi adapter.)

### Two things will not work, by design

- **Google sync.** Google only allows plain `http://` origins for `localhost`,
  so a LAN IP cannot be added to the authorised origins list. Sync will fail
  and say so.
- **Install, offline mode and notifications.** Service workers require a secure
  context. `http://` on a LAN address is not one.

So this tests **layout, touch and drag** — which is exactly what benefits most
from real-device eyes.

### If the page will not load

- **Turn off NordVPN.** A VPN client will normally stop your phone reaching the
  laptop across the local network. This is the most likely cause.
- Check both devices are on the same Wi-Fi (not one on guest Wi-Fi, or one on
  mobile data).
- Windows Firewall may prompt on first connection — allow it for **Private**
  networks.
- Confirm the server is up by loading http://localhost:8000 on the laptop
  first.

---

## 3. Deployed over HTTPS

The only way to test the whole thing: installing to the home screen, running
offline, and receiving a notification with the app closed.

That means GitHub Pages or Cloudflare Pages, then adding that origin to the
OAuth client's authorised JavaScript origins. See README.md and
SETUP-GOOGLE.md.

---

## Known limits of the automated checks

The preview browser used during development cannot compute flex layout and
ignores CSS transforms, so anything about **visual arrangement** has been
verified by measurement and logic, never by eye. Bugs of the "400-pixel plus
sign" and "chip sliced through the middle" variety are exactly what that
misses. A real look at a real screen is not redundant here.
