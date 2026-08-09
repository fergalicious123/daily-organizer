/* Notifications.
 *
 * Be clear about what a web app can and cannot do here, because the difference
 * matters on a phone:
 *
 *   In-app / foreground  — the Notification API fires while the app is open
 *                          (or installed and running in the background). This
 *                          module schedules those.
 *   App fully closed     — a browser cannot wake itself without a push server.
 *                          So timed items are written to Google Calendar with
 *                          a reminder attached (see google.js: itemToEvent),
 *                          and the phone's Google Calendar app delivers the
 *                          notification natively. That is the path that
 *                          actually reaches you at 7am with this app shut.
 *
 * Scheduling here is a rolling window rather than one timer per item:
 * setTimeout is unreliable past ~24 days and a hundred pending timers is
 * wasteful. We re-arm the next hour's worth every few minutes.
 */

import { liveItems, settings } from './state.js';
import { todayKey } from './dates.js';

const LOOKAHEAD_MS = 60 * 60 * 1000;   // arm anything due within the next hour
const REARM_MS = 5 * 60 * 1000;

class NotificationManager {
  constructor() {
    this.timers = new Map();   // itemId -> timeout handle
    this.fired = new Set();    // itemId+time, so a re-arm never double-fires
    this.interval = null;
  }

  get supported() {
    return 'Notification' in window;
  }

  get permission() {
    return this.supported ? Notification.permission : 'unsupported';
  }

  statusText() {
    if (!this.supported) return 'This browser does not support notifications.';
    if (Notification.permission === 'granted') return 'In-app notifications are on.';
    if (Notification.permission === 'denied') {
      return 'Blocked. Re-enable them in your browser’s site settings for this page.';
    }
    return 'Not enabled yet.';
  }

  async requestPermission() {
    if (!this.supported) return false;
    if (Notification.permission === 'granted') return true;
    if (Notification.permission === 'denied') return false;
    try {
      const result = await Notification.requestPermission();
      if (result === 'granted') this.rearm();
      return result === 'granted';
    } catch {
      return false;
    }
  }

  init() {
    if (!this.supported) return;
    this.rearm();
    clearInterval(this.interval);
    this.interval = setInterval(() => this.rearm(), REARM_MS);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) this.rearm();
    });
  }

  /** Re-scan upcoming items and arm timers for the next hour. */
  rearm() {
    if (this.permission !== 'granted') return;

    for (const handle of this.timers.values()) clearTimeout(handle);
    this.timers.clear();

    const now = Date.now();
    const cfg = settings();

    for (const item of liveItems()) {
      if (item.done || !item.date || !item.time) continue;

      const lead = item.remindMin ?? cfg.defaultRemindMin;
      const due = new Date(`${item.date}T${item.time}:00`).getTime() - lead * 60_000;
      const delay = due - now;
      if (delay < 0 || delay > LOOKAHEAD_MS) continue;

      const key = `${item.id}@${item.date}T${item.time}`;
      if (this.fired.has(key)) continue;

      const handle = setTimeout(() => {
        this.fired.add(key);
        this.timers.delete(item.id);
        this.show(item.title || 'Reminder', {
          body: lead > 0
            ? `Starts at ${item.time} — in ${lead} minute${lead === 1 ? '' : 's'}.`
            : `Starting now (${item.time}).`,
          tag: item.id,
        });
      }, delay);

      this.timers.set(item.id, handle);
    }

    // Keep the dedupe set from growing forever.
    if (this.fired.size > 400) {
      const today = todayKey();
      for (const key of this.fired) {
        if (!key.includes(today)) this.fired.delete(key);
      }
    }
  }

  show(title, options = {}) {
    if (this.permission !== 'granted') return null;
    try {
      const notification = new Notification(title, {
        icon: 'icons/icon-192.png',
        badge: 'icons/icon-192.png',
        ...options,
      });
      notification.onclick = () => {
        window.focus();
        notification.close();
      };
      return notification;
    } catch {
      // Android Chrome refuses constructed Notifications and demands the
      // service worker path instead.
      navigator.serviceWorker?.ready
        .then((reg) => reg.showNotification(title, { icon: 'icons/icon-192.png', ...options }))
        .catch(() => { /* nothing more we can do */ });
      return null;
    }
  }
}

export const notifications = new NotificationManager();
