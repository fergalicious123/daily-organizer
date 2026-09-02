/* Application controller: routing, chrome, and wiring.
 *
 * Rendering is deliberately full-redraw-per-region rather than a virtual DOM.
 * The data here is small (a few hundred items at most), the views are cheap,
 * and "rebuild the region on change" removes a whole category of stale-UI
 * bugs for a fraction of the complexity a diffing layer would cost.
 */

import {
  el, clear, icon, toast, openModal, closeModal, confirmDialog, isMobile, isTablet, $,
} from './ui.js';
import {
  store, settings, updateSettings, device, updateDevice,
  addList, removeList, renameList,
  liveItems, itemsOnDay, itemsInRange, unscheduledTasks, overdueTasks,
  tasksInList, progressFor, completionHistory, currentStreak, getList,
  completedItems, rollOverdueTasks, rolloverDue, reviewDue, shiftBlock, openCaptures,
  routineSteps, setRoutineTarget,
} from './state.js';
import { daysUntil } from './countdown.js';
import { search } from './search.js';
import { openDiaryOn } from './views/journal.js';
import * as usage from './usage.js';
import {
  todayKey, addDays, addMonths, weekDays, fromKey,
  formatMonthLong, formatMonthShort, formatWeekRange, formatDayLong, formatDayShort,
  formatDayHeader, formatRelativeDay,
  isoWeekNumber, DAY_ABBR, monthGrid, isToday, isPast, sameMonth,
} from './dates.js';
import {
  monthView, weekView, dayView, fitMonthChips, makeDropTarget, dayStrip,
} from './views/calendar.js';
import { doneView } from './views/done.js';
import { reviewView } from './views/review.js';
import { journalView, journalEditor } from './views/journal.js';
import { mountClockWidget, startClockTicker } from './views/clocks.js';
import { mountShortcutsButton } from './views/shortcutsPanel.js';
import { mountBin, binPanel } from './views/bin.js';
import { planPanel } from './views/planpanel.js';
import { declaredKeys } from './shortcuts.js';
import { homeView } from './views/home.js';
import { taskList, quickAdd, openItemEditor, confirmDeleteList } from './views/tasks.js';
import { progressRing, historyColumns, listBars, sparkline } from './chart.js';
// Speech capture is currently switched off — see the note at the top of
// voice.js. The natural-language parser stays, because it is what makes the
// quick-add boxes understand "call mum tomorrow at 3".
import { parseCommand, voice } from './voice.js';
import { sync, SyncState } from './sync.js';
import { google } from './google.js';
import { notifications } from './notify.js';

/* ------------------------------------------------------------------ */
/* Route                                                               */
/* ------------------------------------------------------------------ */

const route = {
  view: 'home',         // home | month | week | day | tasks | done | journal | stats | review
  anchor: todayKey(),   // the date the view is centred on
  listId: null,         // when view === 'tasks'
};

/** Which counter a view belongs to. Views not listed simply are not counted. */
const VIEW_FEATURE = {
  home: 'VIEW_HOME', day: 'VIEW_DAY', week: 'VIEW_WEEK', month: 'VIEW_MONTH',
  tasks: 'VIEW_TASKS', journal: 'VIEW_JOURNAL', review: 'VIEW_REVIEW',
  stats: 'VIEW_STATS',
};

function navigate(patch) {
  // Leaving a view takes its microphone with it. The diary's mic had the same
  // hole as the item editor's: start dictating, tap another view, and the
  // control that would have stopped it is gone while the recogniser carries on.
  if (voice.listening) voice.stop();
  // Only when the view actually CHANGES. Stepping through days with the
  // arrows calls this on every press with the same view, and counting those
  // would make the day view look like the most-used thing in the app by an
  // order of magnitude — measuring the arrow keys, not the view.
  const changed = patch.view && patch.view !== route.view;
  Object.assign(route, patch);
  persistRoute();
  if (changed && VIEW_FEATURE[route.view]) usage.record(VIEW_FEATURE[route.view]);
  render();
}

function persistRoute() {
  try {
    sessionStorage.setItem('daily-organizer:route', JSON.stringify(route));
  } catch { /* private mode */ }
}

/** Views a URL is allowed to ask for. Anything else is ignored. */
const ROUTABLE = new Set(['home', 'month', 'week', 'day', 'tasks', 'done', 'journal', 'stats', 'review']);

function restoreRoute() {
  try {
    const saved = JSON.parse(sessionStorage.getItem('daily-organizer:route'));
    if (saved?.view) Object.assign(route, saved);
    // Never restore to a stale day — reopening the app means "now".
    if (route.view === 'day' && route.anchor < todayKey()) route.anchor = todayKey();
  } catch { /* fine */ }

  /*
   * A view asked for in the URL wins over the restored one.
   *
   * This is what makes the home-screen shortcuts real: long-pressing the icon
   * on Android offers "Today" and "Review", and both are plain URLs. Without
   * this they would open wherever you happened to be last, which is a shortcut
   * that lies about where it goes.
   *
   * Checked against a list rather than trusted, so a hand-edited URL cannot put
   * the app into a view that does not exist and leave it blank.
   */
  try {
    const asked = new URLSearchParams(location.search).get('view');
    if (asked && ROUTABLE.has(asked)) {
      route.view = asked;
      if (asked === 'day') route.anchor = todayKey();
      if (asked === 'tasks') route.listId = null;
      // Take the parameter out of the address bar once it has been used, so a
      // later reload does not drag you back here.
      history.replaceState(null, '', location.pathname);
    }
  } catch { /* no URL API, or a blocked history write */ }
}

/* ------------------------------------------------------------------ */
/* Elements                                                            */
/* ------------------------------------------------------------------ */

const sidebarEl = $('#sidebar');
const headerEl = $('#mainHeader');
const bodyEl = $('#viewBody');
const railEl = $('#rail');
const tabbarEl = $('#tabbar');
const scrimEl = $('#scrim');

/* ------------------------------------------------------------------ */
/* Sidebar                                                             */
/* ------------------------------------------------------------------ */

function renderSidebar() {
  clear(sidebarEl);
  const cfg = settings();

  // The brand is the way home — the convention every app trains people in.
  sidebarEl.appendChild(el('button.brand', {
    title: 'Go to Home',
    'aria-label': 'Go to Home',
    onclick: () => { navigate({ view: 'home' }); closeDrawers(); },
  },
    el('div.brand-mark', 'D'),
    el('div',
      el('div.brand-name', 'Daily Organizer'),
      el('div.brand-sub', formatDayShort(todayKey())),
    ),
  ));

  /* nav */
  const todayCount = itemsOnDay(todayKey()).filter((i) => !i.done).length;
  const overdueCount = overdueTasks().length;
  const inboxCount = unscheduledTasks().filter((i) => !i.done).length;

  sidebarEl.appendChild(el('div.nav',
    navItem('home', 'Home', null, route.view === 'home',
      () => navigate({ view: 'home' })),
    navItem('today', 'Today', todayCount, route.view === 'day' && route.anchor === todayKey(),
      () => navigate({ view: 'day', anchor: todayKey() })),
    navItem('calendar', 'Calendar', null, ['month', 'week'].includes(route.view),
      () => navigate({ view: 'month', anchor: route.anchor })),
    navItem('inbox', 'Unscheduled', inboxCount, route.view === 'tasks' && !route.listId,
      () => navigate({ view: 'tasks', listId: null })),
    overdueCount ? navItem('warning', 'Overdue', overdueCount, false,
      () => navigate({ view: 'tasks', listId: 'overdue' }), true) : null,
    navItem('check', 'Completed', completedItems().length, route.view === 'done',
      () => navigate({ view: 'done' })),
    navItem('book', 'Diary', null, route.view === 'journal',
      () => navigate({ view: 'journal' })),
    // Badged rather than merely present when a block has finished: the whole
    // point of a review is that it happens at a moment, and a nav item that
    // looks identical every day is one you never think to press.
    navItem('review', 'Review', reviewDue() ? '●' : null, route.view === 'review',
      () => navigate({ view: 'review' }), reviewDue()),
    navItem('chart', 'Progress', null, route.view === 'stats',
      () => navigate({ view: 'stats' })),
  ));

  /*
   * Catch, the note app. A real link, not a route: it is a separate app that
   * happens to share this one's storage and its address. Kept apart from the
   * nav above because those switch views and this leaves — and shown with the
   * number waiting, since a pile you have not sorted is the only reason to go.
   */
  const waiting = openCaptures().length;
  sidebarEl.appendChild(el('a.nav-item.nav-external', { href: './capture/' },
    icon('mic'),
    el('span', { style: { flex: '1', textAlign: 'left' } }, 'Catch a note'),
    waiting ? el('span.count', String(waiting)) : null,
  ));

  /* mini month */
  sidebarEl.appendChild(miniCalendar());

  /* lists */
  const listsHost = el('div');
  listsHost.appendChild(el('div.section-label',
    el('span', 'Lists'),
    el('button', {
      title: 'New list',
      'aria-label': 'New list',
      onclick: promptNewList,
    }, '+'),
  ));
  const nav = el('div.nav');
  for (const list of [...store.state.lists].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
    const open = tasksInList(list.id).filter((i) => !i.done).length;
    nav.appendChild(el('button.nav-item', {
      class: route.view === 'tasks' && route.listId === list.id ? 'is-active' : '',
      onclick: () => navigate({ view: 'tasks', listId: list.id }),
      oncontextmenu: (e) => { e.preventDefault(); listContextMenu(list); },
    },
      el('span.list-dot', { style: { background: list.color, color: list.color } }),
      el('span', { style: { flex: '1', textAlign: 'left', minWidth: '0' } }, list.name),
      open ? el('span.count', String(open)) : null,
    ));
  }
  listsHost.appendChild(nav);
  sidebarEl.appendChild(listsHost);

  /* Progress card — omitted wherever the main area already shows the same
     figure: the Progress view, and the Day view's own "This day" card. The
     identical ring twice on one screen is noise, and it costs vertical space
     the sidebar cannot spare on a short window.
     Day keeps the main-area copy rather than this one, because on a phone the
     sidebar is a closed drawer and dropping that copy would leave the day with
     no progress reading at all. */
  if (route.view !== 'stats' && route.view !== 'day') {
    const scopeItems = scopeItemsForProgress();
    sidebarEl.appendChild(el('div.progress-card',
      el('div.progress-card-head',
        el('span.progress-card-title', 'Progress'),
        el('span.progress-card-scope', progressScopeLabel()),
      ),
      progressRing(progressFor(scopeItems), { size: 128, label: progressScopeLabel() }),
    ));
  }

  /* spacer pushes the footer down when there is room to spare */
  sidebarEl.appendChild(el('div', { style: { flex: '1', minHeight: '8px' } }));

  /* Sync status, theme and settings are pinned. On a short window the
     sidebar scrolls, and previously these fell below the fold with nothing
     to suggest they existed — including the only route to Settings. */
  sidebarEl.appendChild(el('div.sidebar-footer',
    syncStatusButton(),
    el('div.nav',
      navItem(cfg.theme === 'dark' ? 'moon' : 'sun', 'Theme', null, false, cycleTheme),
      navItem('search', 'Find', null, false, openSearch),
      navItem('settings', 'Settings', null, false, openSettings),
    ),
  ));
}

function navItem(iconName, label, count, active, onClick, alert = false) {
  return el('button.nav-item', {
    class: active ? 'is-active' : '',
    onclick: () => { onClick(); closeDrawers(); },
  },
    icon(iconName),
    el('span', { style: { flex: '1', textAlign: 'left' } }, label),
    // A badge is usually a count, but not always: the review shows a dot,
    // because "how many reviews are outstanding" is not a question anyone
    // asks. Testing `count > 0` alone silently dropped it — a string is never
    // greater than zero.
    (typeof count === 'string' ? count.length > 0 : (count != null && count > 0))
      ? el('span.count', { class: alert ? 'is-alert' : '' }, String(count))
      : null,
  );
}

function miniCalendar() {
  const cfg = settings();
  const anchor = route.anchor || todayKey();
  const grid = monthGrid(anchor, cfg.weekStart);
  const host = el('div.mini-cal');

  host.appendChild(el('div.mini-head',
    el('span.mini-title', formatMonthLong(anchor)),
    el('div.mini-nav',
      el('button', {
        'aria-label': 'Previous month',
        onclick: () => navigate({ anchor: addMonths(anchor, -1) }),
      }, icon('chevronLeft')),
      el('button', {
        'aria-label': 'Next month',
        onclick: () => navigate({ anchor: addMonths(anchor, 1) }),
      }, icon('chevronRight')),
    ),
  ));

  const g = el('div.mini-grid');
  for (let i = 0; i < 7; i++) {
    g.appendChild(el('div.mini-dow', DAY_ABBR[(cfg.weekStart + i) % 7].slice(0, 1)));
  }
  for (const week of grid) {
    for (const dayKey of week) {
      const count = itemsOnDay(dayKey).length;
      const dayBtn = el('button.mini-day', {
        class: [
          !sameMonth(dayKey, anchor) ? 'is-outside' : '',
          isToday(dayKey) ? 'is-today' : '',
          isPast(dayKey) ? 'is-past' : '',
          dayKey === route.anchor && route.view === 'day' ? 'is-selected' : '',
          count ? 'has-items' : '',
        ].filter(Boolean).join(' '),
        onclick: () => { navigate({ view: 'day', anchor: dayKey }); closeDrawers(); },
      }, String(fromKey(dayKey).getDate()));
      // The mini-calendar is the one date picker visible from every view, so
      // it is the natural target for dragging something back onto a day.
      makeDropTarget(dayBtn, dayKey, null);
      g.appendChild(dayBtn);
    }
  }
  host.appendChild(g);
  return host;
}

function scopeItemsForProgress() {
  if (route.view === 'day') return itemsOnDay(route.anchor);
  if (route.view === 'week') {
    const days = weekDays(route.anchor, settings().weekStart);
    return itemsInRange(days[0], days[6]);
  }
  if (route.view === 'month') {
    const grid = monthGrid(route.anchor, settings().weekStart);
    return itemsInRange(grid[0][0], grid[grid.length - 1][6]);
  }
  if (route.view === 'tasks') {
    if (route.listId === 'overdue') return overdueTasks();
    if (route.listId) return tasksInList(route.listId);
    return unscheduledTasks();
  }
  return itemsOnDay(todayKey());
}

function progressScopeLabel() {
  if (route.view === 'day') return route.anchor === todayKey() ? 'today' : 'this day';
  if (route.view === 'week') return 'this week';
  if (route.view === 'month') return 'this month';
  if (route.view === 'tasks') return 'this list';
  return 'today';
}

function syncStatusButton() {
  const dotClass = {
    [SyncState.OK]: 'is-ok',
    [SyncState.SYNCING]: 'is-busy',
    [SyncState.ERROR]: 'is-error',
    [SyncState.OFFLINE]: 'is-error',
    [SyncState.IDLE]: '',
  }[sync.state] || '';

  const offline = sync.state === SyncState.ERROR || sync.state === SyncState.IDLE;

  return el('button.sync-status', {
    // Say why, when we know why. The reason a silent renewal failed is the
    // difference between "click here" and "this will keep happening until you
    // allow third-party cookies", and both used to read as "Connect".
    title: offline
      ? (sync.lastError?.message
        ? `${sync.lastError.message}
Click to connect.`
        : 'Connect to Google and sync')
      : (sync.lastError?.message || sync.message),
    /*
     * One click, and it connects.
     *
     * This used to open Settings when disconnected, so reconnecting was: click
     * the chip, find the Google section, click Connect, then deal with Google.
     * Three clicks and a hunt to do the one thing the chip is about. It goes
     * straight to Google now, and only falls back to Settings if there is
     * something to configure — which is the only case Settings actually helps
     * with.
     *
     * The click matters for another reason: Google's sign-in is a popup, and a
     * popup opened without a user gesture is blocked by the browser. So this
     * cannot be made to happen on its own; what CAN be made automatic is not
     * needing it, which is what the silent renewal does.
     */
    onclick: async (e) => {
      if (!offline) { sync.syncNow(); return; }
      const button = e.currentTarget;
      button.disabled = true;
      try {
        usage.record('SYNC_CONNECT');
        await sync.connect({ interactive: true });
        toast('Connected — syncing now.');
      } catch (err) {
        toast(err.message || 'Could not connect.', { error: true });
        openSettings('google');
      } finally {
        button.disabled = false;
      }
    },
  },
    el('span.sync-dot', { class: dotClass }),
    el('span.sync-text', sync.message),
  );
}

/* ------------------------------------------------------------------ */
/* Header                                                              */
/* ------------------------------------------------------------------ */

function renderHeader() {
  clear(headerEl);

  if (isMobile()) {
    headerEl.appendChild(el('button.btn.btn-ghost.btn-icon', {
      'aria-label': 'Menu',
      onclick: () => openDrawer(sidebarEl),
    }, icon('menu')));
  }

  headerEl.appendChild(breadcrumb());
  headerEl.appendChild(el('div.header-spacer'));

  if (['month', 'week', 'day'].includes(route.view)) {
    headerEl.appendChild(el('div', { style: { display: 'flex', gap: '4px' } },
      el('button.btn.btn-ghost.btn-icon', {
        'aria-label': 'Previous',
        onclick: () => navigate({ anchor: stepAnchor(-1) }),
      }, icon('chevronLeft')),
      el('button.btn.btn-ghost', { onclick: () => navigate({ anchor: todayKey() }) }, 'Today'),
      el('button.btn.btn-ghost.btn-icon', {
        'aria-label': 'Next',
        onclick: () => navigate({ anchor: stepAnchor(1) }),
      }, icon('chevronRight')),
    ));

    if (!isMobile()) {
      headerEl.appendChild(el('div.segmented',
        ...['month', 'week', 'day'].map((v) => el('button', {
          class: route.view === v ? 'is-active' : '',
          onclick: () => navigate({ view: v }),
        }, v[0].toUpperCase() + v.slice(1))),
      ));
    }
  }

  headerEl.appendChild(el('button.btn.btn-primary', {
    onclick: () => openItemEditor(null, defaultsForRoute()),
  }, icon('plus'), isMobile() ? '' : 'New'));
}

function breadcrumb() {
  const crumbs = el('div.breadcrumb');
  const cfg = settings();

  if (route.view === 'home') {
    crumbs.appendChild(el('span.crumb.is-current', 'Home'));
    return crumbs;
  }

  if (route.view === 'done') {
    crumbs.appendChild(el('span.crumb.is-current', 'Completed'));
    return crumbs;
  }

  if (route.view === 'journal') {
    crumbs.appendChild(el('span.crumb.is-current', 'Diary'));
    return crumbs;
  }

  if (route.view === 'review') {
    crumbs.appendChild(el('span.crumb.is-current', 'Review'));
    return crumbs;
  }

  if (route.view === 'stats') {
    crumbs.appendChild(el('span.crumb.is-current', 'Progress'));
    return crumbs;
  }

  if (route.view === 'tasks') {
    const name = route.listId === 'overdue'
      ? 'Overdue'
      : route.listId ? (getList(route.listId)?.name || 'List') : 'Unscheduled';
    crumbs.appendChild(el('span.crumb.is-current', name));
    return crumbs;
  }

  // The drill-down path is always visible and always clickable back up.
  /* Short on a phone, and only when it is the CURRENT crumb -- as a trail
     link it is hidden there anyway. "September 2026" wanted 120px of the 112
     the month header has once the menu, the arrows either side of Today and
     New have taken theirs, so it was being clipped to "September 2...". */
  const monthIsCurrent = route.view === 'month';
  crumbs.appendChild(el('button.crumb', {
    class: monthIsCurrent ? 'is-current' : '',
    onclick: () => navigate({ view: 'month' }),
  }, monthIsCurrent && isMobile()
    ? formatMonthShort(route.anchor)
    : formatMonthLong(route.anchor)));

  if (route.view === 'week' || route.view === 'day') {
    crumbs.appendChild(el('span.crumb-sep', '›'));
    crumbs.appendChild(el('button.crumb', {
      class: route.view === 'week' ? 'is-current' : '',
      onclick: () => navigate({ view: 'week' }),
      // "Wk" rather than "Week": this is the current crumb in week view, and
      // spelling it out cost the ~14px that pushed the date range into an
      // ellipsis. The month grid labels its rows the same way.
      // Same reasoning as the month above: on a phone the range alone
      // identifies the week, and the number is one the header has no room for.
    }, isMobile() && route.view === 'week'
      ? formatWeekRange(route.anchor, cfg.weekStart)
      : `Wk ${isoWeekNumber(route.anchor)} · ${formatWeekRange(route.anchor, cfg.weekStart)}`));
  }

  if (route.view === 'day') {
    crumbs.appendChild(el('span.crumb-sep', '›'));
    // 'Today' alone used to be the whole crumb, which is friendly and answers
    // the wrong question: Ben's complaint was that he could not tell what day
    // he was looking at, and on the one day where that is easiest to say the
    // header was saying the least. The date rides along with it.
    // On a phone the trail is hidden (see the crumb rules in styles.css) and
    // the header is still only ~130px wide once the menu, the arrows either
    // side of Today and New have taken their share — so the day is abbreviated
    // there rather than truncated, which is the failure this is fixing.
    crumbs.appendChild(el('span.crumb.is-current',
      isMobile()
        ? formatDayShort(route.anchor)
        : route.anchor === todayKey()
          ? `Today · ${formatDayShort(route.anchor)}`
          : formatDayHeader(route.anchor)));
  }

  return crumbs;
}

function stepAnchor(direction) {
  if (route.view === 'month') return addMonths(route.anchor, direction);
  if (route.view === 'week') return addDays(route.anchor, 7 * direction);
  return addDays(route.anchor, direction);
}

function defaultsForRoute() {
  if (route.view === 'day') return { date: route.anchor };
  if (route.view === 'tasks' && route.listId && route.listId !== 'overdue') {
    return { listId: route.listId };
  }
  return {};
}

/* ------------------------------------------------------------------ */
/* Main body                                                           */
/* ------------------------------------------------------------------ */

function renderBody() {
  clear(bodyEl);

  if (route.view === 'home') {
    bodyEl.appendChild(homeView({ onNavigate: navigate }));
  } else if (route.view === 'month') {
    bodyEl.appendChild(monthView(route.anchor, {
      onSelectWeek: (weekKey) => navigate({ view: 'week', anchor: weekKey }),
      onSelectDay: (dayKey) => navigate({ view: 'day', anchor: dayKey }),
    }));
    // Chip capacity depends on the laid-out cell height, which depends on
    // whether the month needs five week rows or six. Must run after mount.
    fitMonthChips(bodyEl);
  } else if (route.view === 'week') {
    bodyEl.appendChild(weekView(route.anchor, {
      onSelectDay: (dayKey) => navigate({ view: 'day', anchor: dayKey }),
    }));
  } else if (route.view === 'day') {
    bodyEl.appendChild(dayView(route.anchor));
  } else if (route.view === 'tasks') {
    bodyEl.appendChild(tasksView());
  } else if (route.view === 'done') {
    bodyEl.appendChild(doneView({ onNavigate: navigate }));
  } else if (route.view === 'journal') {
    bodyEl.appendChild(journalView({ onNavigate: navigate }));
  } else if (route.view === 'review') {
    bodyEl.appendChild(reviewView());
  } else if (route.view === 'stats') {
    bodyEl.appendChild(statsView());
  }
}

function tasksView() {
  const root = el('div.view-anim', { style: { padding: '16px 18px', maxWidth: '760px' } });

  let items;
  let title;
  let emptyMessage;

  if (route.listId === 'overdue') {
    items = overdueTasks();
    title = 'Overdue';
    emptyMessage = 'Nothing overdue. ';
  } else if (route.listId) {
    items = tasksInList(route.listId);
    title = getList(route.listId)?.name || 'List';
    emptyMessage = 'This list is empty';
  } else {
    items = unscheduledTasks();
    title = 'Unscheduled';
    emptyMessage = 'Nothing waiting';
  }

  if (route.listId !== 'overdue') {
    root.appendChild(quickAdd({
      defaults: route.listId ? { listId: route.listId } : {},
      parser: parseCommand,
      placeholder: `Add to ${title}…  (try “call mum tomorrow at 3”)`,
      focusId: 'quick-add-list',
    }));
  }

  // Somewhere to drop things. Without this the list views show tasks with no
  // calendar in sight, so dragging one to a day had no target on screen.
  root.appendChild(dayStrip({
    onSelectDay: (dayKey) => navigate({ view: 'day', anchor: dayKey }),
    onOpenUnscheduled: () => navigate({ view: 'tasks', listId: null }),
  }));

  // The plan sits directly under the day strip, because the strip is what you
  // drag its steps onto — the target is on screen with the thing being dragged.
  if (route.listId === 'overdue') {
    const panel = planPanel();
    if (panel) root.appendChild(panel);
  }

  // Group-by control. Only worth showing once there is enough here for
  // grouping to organise anything.
  if (items.length > 2) {
    root.appendChild(el('div.group-bar',
      el('span.group-bar-label', 'Group'),
      el('div.segmented',
        ...[['none', 'None'], ['due', 'Due'], ['priority', 'Priority'], ['list', 'List']]
          .map(([value, label]) => el('button', {
            class: (settings().groupBy || 'none') === value ? 'is-active' : '',
            onclick: () => { updateSettings({ groupBy: value }); render(); },
          }, label)),
      ),
    ));
  }

  root.appendChild(taskList(items, {
    emptyMessage,
    emptyHint: route.listId === 'overdue' ? '' : 'Type above, or drag one onto a day.',
    groupBy: settings().groupBy || 'none',
  }));

  return root;
}

function statsView() {
  const root = el('div.stats.view-anim');
  const today = itemsOnDay(todayKey());
  const week = (() => {
    const days = weekDays(todayKey(), settings().weekStart);
    return itemsInRange(days[0], days[6]);
  })();
  const history = completionHistory(7);
  const streak = currentStreak();

  root.appendChild(el('div.stat-card',
    el('h3', 'Today'),
    progressRing(progressFor(today), { size: 150, label: 'Today' }),
    el('p.stat-sub', { style: { textAlign: 'center', margin: 0 } },
      `${progressFor(today).done} of ${progressFor(today).total} tasks done`),
  ));

  root.appendChild(el('div.stat-card',
    el('h3', 'This week'),
    progressRing(progressFor(week), { size: 150, label: 'This week' }),
    el('p.stat-sub', { style: { textAlign: 'center', margin: 0 } },
      `${progressFor(week).done} of ${progressFor(week).total} tasks done`),
  ));

  root.appendChild(el('div.stat-card',
    el('h3', 'Completed per day'),
    historyColumns(history),
  ));

  root.appendChild(el('div.stat-card',
    el('h3', 'Streak'),
    el('div.stat-row',
      el('div',
        el('div.stat-big', String(streak)),
        el('p.stat-sub', { style: { margin: 0 } },
          streak === 0 ? 'Finish something today' : `day${streak === 1 ? '' : 's'} in a row`),
      ),
      sparkline(history.map((h) => h.count)),
    ),
  ));

  /* ---- what actually gets used ----
     Built to answer one question in three months: what should come out? So it
     shows the FULL list, zeros and all, ranked. A feature at zero is the most
     useful row here and would be invisible in a list of things you have used.
     It lives on Progress rather than in Settings because it is a statistic
     about how the app is going, which is what this page is. */
  const usageRows = usage.report();
  const usedAt = usage.since();
  const usedTotal = usageRows.reduce((a, r) => a + r.n, 0);
  const top = usageRows[0]?.n || 0;
  const unused = usageRows.filter((r) => !r.n).length;

  root.appendChild(el('div.stat-card.usage-card',
    el('h3', 'What you actually use'),
    usedTotal === 0
      ? el('p.stat-sub', { style: { margin: 0 } },
          'Nothing counted yet. Use the app for a while and this fills in.')
      : el('div',
        el('p.stat-sub', { style: { margin: '0 0 10px' } },
          `${usedTotal} actions counted`,
          usedAt ? ` since ${formatDayShort(usedAt.slice(0, 10))}` : '',
          unused ? ` · ${unused} never used` : '',
        ),
        el('div.usage-list', usageRows.map((row) => el('div.usage-row',
          { class: row.n ? '' : 'is-unused' },
          el('span.usage-label', row.label),
          el('span.usage-bar',
            el('span', { style: { width: `${top ? Math.round((row.n / top) * 100) : 0}%` } })),
          el('span.usage-n', String(row.n)),
        ))),
        el('p.field-hint', { style: { marginTop: '10px' } },
          'Counted on this device and any other you sync with, and kept in your own '
          + 'Drive file. Counters and dates only — no titles, no text. '
          + 'Nothing is sent anywhere it was not already going.'),
        el('button.btn.btn-quiet', {
          style: { marginTop: '8px' },
          onclick: async () => {
            const ok = await confirmDialog({
              title: 'Start counting again?',
              message: 'Clears every count on every device you sync with. The app itself is unchanged.',
              confirmLabel: 'Reset counts',
              danger: true,
            });
            if (!ok) return;
            usage.reset();
            render();
          },
        }, 'Reset counts'),
      ),
  ));

  root.appendChild(el('div.stat-card',
    el('h3', 'By list'),
    listBars(store.state.lists.map((list) => {
      const tasks = tasksInList(list.id);
      return { name: list.name, done: tasks.filter((t) => t.done).length, total: tasks.length };
    }).filter((r) => r.total > 0)),
  ));

  const overdue = overdueTasks();
  root.appendChild(el('div.stat-card',
    el('h3', 'Needs attention'),
    el('div.stat-big', { style: { color: overdue.length ? 'var(--danger)' : 'var(--success)' } },
      String(overdue.length)),
    el('p.stat-sub', { style: { margin: 0 } },
      overdue.length ? 'overdue tasks' : 'nothing overdue'),
    overdue.length
      ? el('button.btn', { onclick: () => navigate({ view: 'tasks', listId: 'overdue' }) }, 'Review them')
      : null,
  ));

  return root;
}

/* ------------------------------------------------------------------ */
/* Rail                                                                */
/* ------------------------------------------------------------------ */

function renderRail() {
  clear(railEl);

  // In the day view the main panel IS this day's list, so a rail repeating it
  // put the same tasks on screen twice. The day view gets its notes here
  // instead; the backlog sits in the day panel, directly under the tasks it
  // gets dragged into.
  if (route.view === 'day') {
    renderNotesRail(route.anchor);
    return;
  }

  const dayKey = todayKey();
  const items = itemsOnDay(dayKey);
  const unscheduled = unscheduledTasks().filter((i) => !i.done).slice(0, 12);
  const prog = progressFor(items);

  railEl.appendChild(el('div.rail-header',
    el('div.rail-title',
      el('span', 'Today'),
      prog.total ? el('span.rail-sub', `${prog.done}/${prog.total}`) : null,
    ),
    el('div.rail-sub', formatDayLong(dayKey)),
  ));

  const body = el('div.rail-body');
  body.appendChild(quickAdd({
    defaults: { date: dayKey },
    parser: parseCommand,
    placeholder: 'Add to this day…',
    focusId: 'quick-add-rail',
  }));
  body.appendChild(taskList(items, {
    showDate: false,
    emptyMessage: 'Nothing planned',
    emptyHint: 'Add above, or drag something from below.',
  }));

  if (unscheduled.length) {
    body.appendChild(el('div.task-group-label', 'Unscheduled'));
    body.appendChild(taskList(unscheduled, { showDate: false, groupDone: false }));
  }

  railEl.appendChild(body);
}

/**
 * The rail while a day is open: that day's notes.
 *
 * Swapped with the backlog, which now sits in the day panel beneath the day's
 * own tasks — the two lists you move things between belong in one column, and
 * a write-up deserves better than being the last thing at the bottom of a long
 * panel. Here it gets a column to itself and the full height of the window.
 */
function renderNotesRail(dayKey) {
  railEl.appendChild(el('div.rail-header',
    el('div.rail-title', el('span', 'Notes')),
    el('div.rail-sub', formatDayLong(dayKey)),
  ));

  const body = el('div.rail-body');
  body.appendChild(journalEditor(dayKey));
  // Under the notes, where Ben asked for it. Always visible here, unlike the
  // floating one, which you can only find if you are already dragging.
  body.appendChild(binPanel());
  railEl.appendChild(body);
}

/* ------------------------------------------------------------------ */
/* Tab bar (mobile)                                                    */
/* ------------------------------------------------------------------ */

function renderTabbar() {
  clear(tabbarEl);
  const tabs = [
    { id: 'home', label: 'Home', icon: 'home', active: route.view === 'home', go: () => navigate({ view: 'home' }) },
    { id: 'today', label: 'Today', icon: 'today', active: route.view === 'day', go: () => navigate({ view: 'day', anchor: todayKey() }) },
    { id: 'calendar', label: 'Calendar', icon: 'calendar', active: ['month', 'week'].includes(route.view), go: () => navigate({ view: 'month' }) },
    { id: 'tasks', label: 'Tasks', icon: 'list', active: route.view === 'tasks', go: () => navigate({ view: 'tasks', listId: null }) },
    { id: 'stats', label: 'Progress', icon: 'chart', active: route.view === 'stats', go: () => navigate({ view: 'stats' }) },
  ];
  for (const tab of tabs) {
    tabbarEl.appendChild(el('button.tab', {
      class: tab.active ? 'is-active' : '',
      onclick: tab.go,
    }, icon(tab.icon), el('span', tab.label)));
  }
}

/* ------------------------------------------------------------------ */
/* Drawers                                                             */
/* ------------------------------------------------------------------ */

function openDrawer(node) {
  node.classList.add('is-open');
  scrimEl.hidden = false;
  scrimEl.onclick = closeDrawers;
  syncDrawerState();
}

function closeDrawers() {
  sidebarEl.classList.remove('is-open');
  railEl.classList.remove('is-open');
  scrimEl.hidden = true;
  syncDrawerState();
}

/**
 * Keep a closed drawer out of the keyboard tab order and the accessibility
 * tree, in JS rather than CSS.
 *
 * The CSS `visibility: hidden` is the visual half, but it proved unreliable to
 * depend on: a delayed visibility transition never resolves under
 * prefers-reduced-motion, leaving an off-screen drawer fully focusable — you
 * would tab into a panel you cannot see. `inert` is a single boolean the
 * browser cannot half-apply.
 */
function syncDrawerState() {
  const closedOnMobile = isMobile() && !sidebarEl.classList.contains('is-open');
  sidebarEl.inert = closedOnMobile;
  const railClosed = isTablet() && !railEl.classList.contains('is-open');
  railEl.inert = railClosed;
}

/* ------------------------------------------------------------------ */
/* Lists                                                               */
/* ------------------------------------------------------------------ */

function promptNewList() {
  openModal({
    title: 'New list',
    render: () => {
      const input = el('input', { type: 'text', placeholder: 'e.g. Shopping' });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { create(input.value); }
      });
      queueMicrotask(() => input.focus());
      return el('div.field', el('label', 'Name'), input);
    },
    footer: (close) => [
      el('button.btn', { onclick: close }, 'Cancel'),
      el('button.btn.btn-primary', {
        onclick: (e) => create(e.target.closest('.modal').querySelector('input').value),
      }, 'Create'),
    ],
  });

  function create(name) {
    const trimmed = (name || '').trim();
    if (!trimmed) { toast('Give the list a name.', { error: true }); return; }
    addList(trimmed);
    document.querySelector('.overlay')?.remove();
    toast(`Created “${trimmed}”`);
  }
}

function listContextMenu(list) {
  openModal({
    title: list.name,
    render: () => {
      const input = el('input', { type: 'text', value: list.name });
      return el('div.field', el('label', 'Rename'), input);
    },
    footer: (close) => [
      list.id !== store.state.inboxListId
        ? el('button.btn.btn-danger', {
          onclick: async () => {
            const count = tasksInList(list.id).length;
            close();
            if (await confirmDeleteList(list, count)) {
              removeList(list.id);
              if (route.listId === list.id) navigate({ view: 'tasks', listId: null });
              toast(`Deleted “${list.name}”`);
            }
          },
        }, 'Delete')
        : null,
      el('div', { style: { flex: '1' } }),
      el('button.btn', { onclick: close }, 'Cancel'),
      el('button.btn.btn-primary', {
        onclick: (e) => {
          const value = e.target.closest('.modal').querySelector('input').value.trim();
          if (value) renameList(list.id, value);
          close();
        },
      }, 'Save'),
    ],
  });
}

/* ------------------------------------------------------------------ */
/* Search                                                              */
/* ------------------------------------------------------------------ */

const WHERE_LABEL = {
  title: '',
  note: 'in the notes',
  comment: 'in the comment',
  log: 'in a note on it',
  entry: 'in the diary',
  capture: 'caught',
};

/**
 * Find anything you have written down.
 *
 * A dialog rather than a view, because searching is something you do FROM
 * somewhere and want to end up somewhere else -- putting it on the nav would
 * mean leaving wherever you were to look, then navigating back.
 *
 * Results are drawn as you type, straight from memory. There is no debounce
 * because there is nothing to wait for: the whole document is a few hundred
 * kilobytes and a pass over it costs well under a millisecond.
 */
function openSearch() {
  usage.record('SEARCH');
  let query = '';

  openModal({
    title: 'Find',
    width: '560px',
    render: () => {
      const results = el('div.search-results');
      const summary = el('p.field-hint.search-summary');

      const draw = () => {
        clear(results);
        const hits = search(query, {
          items: store.state.items,
          journal: store.state.journal,
          captures: store.state.captures,
        });

        if (!query.trim()) {
          summary.textContent = 'Tasks, events, notes on them, diary entries and caught lines.';
          return;
        }
        if (!hits.length) {
          summary.textContent = `Nothing matches \u201c${query.trim()}\u201d.`;
          return;
        }
        summary.textContent = `${hits.length} result${hits.length === 1 ? '' : 's'}`;

        for (const hit of hits) {
          results.appendChild(el('button.search-hit', {
            onclick: () => {
              closeModal();
              // Straight to the thing, not to a view containing the thing.
              if (hit.kind === 'entry') { openDiaryOn(hit.id); navigate({ view: 'journal' }); }
              else if (hit.kind === 'capture') window.location.href = './capture/';
              else openItemEditor(hit.id);
            },
          },
            el('div.search-hit-main',
              el('span.search-hit-title', { class: hit.done ? 'is-done' : '' }, hit.title),
              hit.snippet ? el('span.search-hit-snippet', hit.snippet) : null,
            ),
            el('div.search-hit-meta',
              el('span.search-hit-kind', hit.kind === 'entry' ? 'diary'
                : hit.kind === 'capture' ? 'caught' : hit.kind),
              WHERE_LABEL[hit.where] ? el('span.search-hit-where', WHERE_LABEL[hit.where]) : null,
              hit.date ? el('span.search-hit-date', formatRelativeDay(hit.date)) : null,
            ),
          ));
        }
      };

      const box = el('input.search-box', {
        type: 'search',
        placeholder: 'heater, para 10, SCA\u2026',
        autocomplete: 'off',
        oninput: (e) => { query = e.target.value; draw(); },
        onkeydown: (e) => {
          e.stopPropagation();
          // Enter opens the first result, so a search can be done without
          // ever leaving the keyboard.
          if (e.key === 'Enter') results.querySelector('.search-hit')?.click();
        },
      });

      draw();
      return [box, summary, results];
    },
  });
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

function openSettings(focusSection = null) {
  usage.record('SETTINGS_OPEN');
  const cfg = settings();

  openModal({
    title: 'Settings',
    render: () => {
      const fields = [];

      /* --- Google --- */
      fields.push(el('div.section-label', { style: { padding: '0' } }, 'Google sync'));

      const clientInput = el('input', {
        type: 'text',
        value: cfg.googleClientId,
        placeholder: '….apps.googleusercontent.com',
        spellcheck: 'false',
        oninput: (e) => updateSettings({ googleClientId: e.target.value.trim() }),
      });
      fields.push(el('div.field',
        el('label', 'OAuth Client ID'),
        clientInput,
        el('p.field-hint',
          'From Google Cloud Console. Step-by-step instructions are in SETUP-GOOGLE.md. ',
          'This is not a secret — browser OAuth clients have none.'),
      ));

      const calSelect = el('select', {
        onchange: (e) => updateSettings({ googleCalendarId: e.target.value }),
      }, el('option', { value: cfg.googleCalendarId || 'primary' },
        cfg.googleCalendarId === 'primary' || !cfg.googleCalendarId ? 'Primary calendar' : cfg.googleCalendarId));

      /**
       * Fill the dropdown with the account's real calendars.
       *
       * `primary` is an API alias rather than a real calendar id — the primary
       * calendar is keyed by the account email. If the stored value is the
       * alias it matches no <option>, the browser quietly selects index 0, and
       * the UI then claims you are syncing whatever sorts first. So resolve
       * the alias and pin the concrete id.
       */
      const loadCalendars = async () => {
        const calendars = await google.listCalendars();

        // The primary calendar's id is the account's email address, so this is
        // where we learn which account we are on without asking for a profile
        // scope. It becomes the sign-in hint, which is what stops Google
        // showing the account chooser — and what lets a silent renewal succeed
        // on a browser signed into more than one Google account.
        const primary = calendars.find((c) => c.primary);
        if (primary?.id && primary.id !== settings().googleAccount) {
          updateSettings({ googleAccount: primary.id });
        }

        const stored = settings().googleCalendarId;
        clear(calSelect);
        for (const c of calendars) {
          calSelect.appendChild(el('option', { value: c.id },
            c.primary ? `${c.name} (primary)` : c.name));
        }
        const chosen = calendars.find((c) => c.id === stored)
          || (stored === 'primary' ? calendars.find((c) => c.primary) : null)
          || calendars.find((c) => c.primary)
          || calendars[0];
        if (chosen) {
          calSelect.value = chosen.id;
          updateSettings({ googleCalendarId: chosen.id });
        }
        // First run: read from everything rather than silently showing one
        // calendar's worth and looking like half the diary vanished.
        if (!Array.isArray(settings().syncCalendarIds) || !settings().syncCalendarIds.length) {
          updateSettings({ syncCalendarIds: calendars.map((c) => c.id) });
        }
        renderReadList(calendars);
        return calendars.length;
      };

      fields.push(el('div.field',
        el('label', 'New items go to'),
        calSelect,
        el('p.field-hint', 'Connect to load your calendars.'),
      ));

      // Which calendars to READ. Separate from the one we write to, because
      // shifts and shared rotas usually live on a calendar you do not create
      // things on — and reading only one is why they never showed up.
      const readList = el('div.cal-picker');
      const readField = el('div.field',
        el('label', 'Show events from'),
        readList,
        el('p.field-hint',
          'Tick every calendar you want to see here. Shifts and work rotas are '
          + 'often on their own calendar — if something is missing from the app, '
          + 'this is almost always why.'),
      );
      fields.push(readField);

      const renderReadList = (calendars) => {
        clear(readList);
        const selected = new Set(
          Array.isArray(settings().syncCalendarIds) && settings().syncCalendarIds.length
            ? settings().syncCalendarIds
            : [settings().googleCalendarId],
        );
        for (const c of calendars) {
          const on = selected.has(c.id);
          readList.appendChild(el('button.cal-option', {
            class: on ? 'is-on' : '',
            role: 'switch',
            'aria-checked': String(on),
            onclick: (e) => {
              const node = e.currentTarget;
              const nowOn = !node.classList.contains('is-on');
              node.classList.toggle('is-on', nowOn);
              node.setAttribute('aria-checked', String(nowOn));
              const next = new Set(
                Array.isArray(settings().syncCalendarIds) && settings().syncCalendarIds.length
                  ? settings().syncCalendarIds
                  : [settings().googleCalendarId],
              );
              if (nowOn) next.add(c.id); else next.delete(c.id);
              // Never end up reading nothing — that looks identical to a
              // broken sync.
              if (next.size === 0) {
                next.add(settings().googleCalendarId);
                node.classList.add('is-on');
                node.setAttribute('aria-checked', 'true');
                toast('At least one calendar has to stay on.');
              }
              updateSettings({ syncCalendarIds: [...next] });
            },
          },
            el('span.cal-tick', icon('check', 'icon')),
            el('span.cal-name', c.primary ? `${c.name} (primary)` : c.name),
            c.accessRole === 'reader' || c.accessRole === 'freeBusyReader'
              ? el('span.cal-ro', 'read-only')
              : null,
          ));
        }
        if (!calendars.length) {
          readList.appendChild(el('p.field-hint', { style: { margin: 0 } },
            'Connect Google to see your calendars.'));
        }
      };

      // Already signed in? Populate straight away rather than making the user
      // click Connect again just to see the list.
      if (google.isSignedIn) {
        loadCalendars().catch((err) => console.warn('Could not list calendars.', err.message));
      }

      const statusLine = el('p.field-hint', sync.message);
      fields.push(el('div.field',
        el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
          el('button.btn.btn-primary', {
            onclick: async (e) => {
              e.target.disabled = true;
              statusLine.textContent = 'Opening Google sign-in…';
              try {
                await sync.connect({ interactive: true });
                statusLine.textContent = 'Connected. Loading your calendars…';
                await loadCalendars();
                statusLine.textContent = 'Connected.';
                toast('Google connected — syncing now.');
              } catch (err) {
                statusLine.textContent = err.message;
              } finally {
                e.target.disabled = false;
              }
            },
          }, icon('cloud'), 'Connect Google'),
          el('button.btn', { onclick: () => { sync.syncNow(); toast('Syncing…'); } }, 'Sync now'),
          cfg.googleEnabled
            ? el('button.btn.btn-danger', {
              onclick: () => { sync.disconnect(); statusLine.textContent = 'Disconnected.'; },
            }, 'Disconnect')
            : null,
        ),
        statusLine,
      ));

      /* --- stay signed in --- */
      const staySwitch = el('div.switch', {
        class: cfg.staySignedIn !== false ? 'is-on' : '',
        role: 'switch',
        tabIndex: 0,
        'aria-checked': String(cfg.staySignedIn !== false),
        onclick: (e) => {
          const on = !e.currentTarget.classList.contains('is-on');
          e.currentTarget.classList.toggle('is-on', on);
          e.currentTarget.setAttribute('aria-checked', String(on));
          updateSettings({ staySignedIn: on });
          google.setPersistence(on);
          toast(on ? 'Will stay signed in between visits' : 'Will re-authorise each visit');
        },
      });
      fields.push(el('div.switch-row',
        el('div',
          el('div.switch-label', 'Stay signed in'),
          el('div.switch-desc',
            'Keeps the Google token between reloads so you are not reconnecting constantly. '
            + 'It is stored in this browser and expires within the hour; Disconnect wipes it.'),
        ),
        staySwitch,
      ));

      /* --- carry unfinished work forward --- */
      const rollSwitch = el('div.switch', {
        class: cfg.rollover !== false ? 'is-on' : '',
        role: 'switch',
        tabIndex: 0,
        'aria-checked': String(cfg.rollover !== false),
        onclick: (e) => {
          const on = !e.currentTarget.classList.contains('is-on');
          e.currentTarget.classList.toggle('is-on', on);
          e.currentTarget.setAttribute('aria-checked', String(on));
          updateSettings({ rollover: on });
          toast(on ? 'Unfinished tasks will carry forward' : 'Tasks will stay on their date');
        },
      });
      fields.push(el('div.switch-row',
        el('div',
          el('div.switch-label', 'Carry unfinished tasks forward'),
          el('div.switch-desc',
            'An overdue task moves to today. If it is still not done, it leaves the '
            + 'calendar and goes to the top of Unscheduled. Events, repeating items and '
            + 'occurrences of a recurring Google entry are never moved.'),
        ),
        rollSwitch,
      ));

      /* --- Notifications --- */
      fields.push(el('div.section-label', { style: { padding: '0' } }, 'Notifications'));
      const notifStatus = el('p.field-hint', notifications.statusText());
      fields.push(el('div.field',
        el('button.btn', {
          onclick: async () => {
            const ok = await notifications.requestPermission();
            notifStatus.textContent = notifications.statusText();
            if (ok) notifications.show('Notifications are on', { body: 'This is what a reminder will look like.' });
          },
        }, icon('bell'), 'Enable notifications'),
        notifStatus,
        el('p.field-hint',
          'In-app alerts fire while the organizer is open. For reminders that reach your phone with the app closed, ',
          'connect Google above — reminders ride on the calendar event and your phone’s Google Calendar app delivers them natively.'),
      ));

      /* --- First things ---
         The morning ritual's own countdowns, editable. The Para 10 one was
         written into the app; this is how the next one gets set without me.
         Label and date only — the order of the steps is the ritual and is not
         something to fiddle with in a settings panel. */
      fields.push(el('div.section-label', { style: { padding: '0' } }, 'First things'));
      for (const step of routineSteps()) {
        const days = daysUntil(step.target);
        const hint = el('p.field-hint');
        const describe = () => {
          hint.textContent = !step.target
            ? 'No countdown. Give it a date and the days remaining show beside the step.'
            : days == null
              ? 'That date has passed, so nothing is shown.'
              : `${days} day${days === 1 ? '' : 's'} to go.`;
        };
        describe();
        fields.push(el('div.field',
          el('label', step.label),
          el('div.field-row',
            el('div.field',
              el('input', {
                type: 'date',
                value: step.target || '',
                'aria-label': `Counting down to, for ${step.label}`,
                onchange: (e) => { setRoutineTarget(step.id, { target: e.target.value || '' }); render(); },
              }),
            ),
            el('div.field',
              el('input', {
                type: 'text',
                placeholder: 'What it is counting to',
                value: step.targetLabel || '',
                'aria-label': `Name of what ${step.label} is counting down to`,
                onchange: (e) => { setRoutineTarget(step.id, { targetLabel: e.target.value.trim() }); render(); },
              }),
            ),
          ),
          hint,
        ));
      }

      /* --- Preferences --- */
      fields.push(el('div.section-label', { style: { padding: '0' } }, 'Preferences'));

      fields.push(el('div.field-row',
        el('div.field',
          el('label', 'Week starts'),
          el('select', {
            onchange: (e) => { updateSettings({ weekStart: Number(e.target.value) }); render(); },
          },
            el('option', { value: '1', selected: cfg.weekStart === 1 }, 'Monday'),
            el('option', { value: '0', selected: cfg.weekStart === 0 }, 'Sunday'),
          ),
        ),
        el('div.field',
          el('label', 'Clock'),
          el('select', {
            onchange: (e) => { updateSettings({ hour12: e.target.value === '12' }); render(); },
          },
            el('option', { value: '12', selected: cfg.hour12 }, '12-hour'),
            el('option', { value: '24', selected: !cfg.hour12 }, '24-hour'),
          ),
        ),
      ));

      fields.push(el('div.field-row',
        el('div.field',
          el('label', 'Day starts at'),
          el('input', {
            type: 'number', min: '0', max: '23', value: String(cfg.dayStart),
            onchange: (e) => { updateSettings({ dayStart: clampHour(e.target.value) }); render(); },
          }),
        ),
        el('div.field',
          el('label', 'Day ends at'),
          el('input', {
            type: 'number', min: '0', max: '23', value: String(cfg.dayEnd),
            onchange: (e) => { updateSettings({ dayEnd: clampHour(e.target.value) }); render(); },
          }),
        ),
      ));

      fields.push(el('div.field-row',
        el('div.field',
          el('label', 'Default reminder (min)'),
          el('input', {
            type: 'number', min: '0', value: String(cfg.defaultRemindMin),
            onchange: (e) => updateSettings({ defaultRemindMin: Math.max(0, Number(e.target.value) || 0) }),
          }),
        ),
        el('div.field',
          el('label', 'Default duration (min)'),
          el('input', {
            type: 'number', min: '5', step: '5', value: String(cfg.defaultDurationMin),
            onchange: (e) => updateSettings({ defaultDurationMin: Math.max(5, Number(e.target.value) || 60) }),
          }),
        ),
      ));

      /* --- Morning brief ---
         These three live on this device only: they are deliberately kept out
         of Drive sync and out of exported backups, so a key can never leave
         by a route nobody was thinking about. See device() in state.js. */
      const dev = device();
      fields.push(el('div.section-label', { style: { padding: '0' } }, 'Morning brief'));
      fields.push(el('div.field',
        el('label', 'Your WhatsApp number'),
        el('input', {
          type: 'tel', placeholder: '+44 7700 900000', value: dev.whatsappNumber || '',
          onchange: (e) => updateDevice({ whatsappNumber: e.target.value.trim() }),
        }),
        el('p.field-hint',
          'Used only to address a message you send yourself. Leave it blank and '
          + 'WhatsApp will ask who to send to. Saved on this device only.'),
      ));

      fields.push(el('div.field',
        el('label', 'CallMeBot key (optional)'),
        el('input', {
          type: 'text', placeholder: 'Leave blank to send by hand', value: dev.callMeBotKey || '',
          onchange: (e) => updateDevice({ callMeBotKey: e.target.value.trim() }),
        }),
        el('p.field-hint',
          'Without this, Send opens WhatsApp with the brief typed out and you press send — '
          + 'no setup, nothing shared. With it, the app sends on its own through CallMeBot, '
          + 'a free relay that reads the message on its way past. Fine for a to-do list; '
          + 'not for anything private.'),
      ));

      fields.push(el('div.field',
        el('label', 'Anthropic API key (optional)'),
        el('input', {
          type: 'password', placeholder: 'sk-ant-…', value: dev.anthropicKey || '',
          onchange: (e) => updateDevice({ anthropicKey: e.target.value.trim() }),
        }),
        el('p.field-hint',
          'Adds a Reword button that has Claude rephrase the brief. The brief itself is '
          + 'always written by the app, so it stays right — and stays working — with this '
          + 'empty. Stored on this device only, never in the app or your backups; set a '
          + 'low spend limit on the key, and leave this blank on a shared computer.'),
      ));

      /* --- Data --- */
      fields.push(el('div.section-label', { style: { padding: '0' } }, 'Your data'));
      fields.push(el('div.field',
        el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
          el('button.btn', { onclick: exportData }, 'Export backup'),
          el('button.btn', { onclick: importData }, 'Import backup'),
        ),
        el('p.field-hint',
          `${liveItems().length} items, ${store.state.lists.length} lists. `,
          cfg.lastSyncAt ? `Last synced ${new Date(cfg.lastSyncAt).toLocaleString()}.` : 'Not synced yet.'),
      ));

      /* --- Version --- */
      // The shortcuts panel shows this too, but that is hidden on a phone —
      // which is the one device where "am I running the new version?" is hard
      // to answer and easy to get wrong.
      fields.push(el('div.section-label', { style: { padding: '0' } }, 'App version'));
      fields.push(versionField());

      return fields;
    },
    footer: (close) => el('button.btn.btn-primary', { onclick: () => { close(); render(); } }, 'Done'),
  });

  if (focusSection === 'google') {
    queueMicrotask(() => document.querySelector('.modal input')?.focus());
  }
}

function clampHour(value) {
  return Math.min(23, Math.max(0, Number(value) || 0));
}

function exportData() {
  const blob = new Blob([JSON.stringify(store.state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: `organizer-backup-${todayKey()}.json` });
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast('Backup downloaded.');
}

function importData() {
  const input = el('input', { type: 'file', accept: 'application/json' });
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!Array.isArray(data.items)) throw new Error('That file is not an organizer backup.');
      const ok = await confirmDialog({
        title: 'Replace everything?',
        message: `This replaces your current data with ${data.items.length} items from the backup. Your current data will be gone.`,
        confirmLabel: 'Replace',
        danger: true,
      });
      if (!ok) return;
      store.replaceState(data);
      render();
      toast('Backup restored.');
    } catch (err) {
      toast(err.message, { error: true });
    }
  });
  input.click();
}

/* ------------------------------------------------------------------ */
/* Theme                                                               */
/* ------------------------------------------------------------------ */

function applyTheme() {
  const theme = settings().theme;
  if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
}

function cycleTheme() {
  const order = ['auto', 'light', 'dark'];
  const next = order[(order.indexOf(settings().theme) + 1) % order.length];
  updateSettings({ theme: next });
  applyTheme();
  render();
  toast(`Theme: ${next}`);
}

/* ------------------------------------------------------------------ */
/* Keyboard                                                            */
/* ------------------------------------------------------------------ */

function installKeyboard() {
  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
    const modal = document.querySelector('.overlay');

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      if (typing) return;
      e.preventDefault();
      if (e.shiftKey) { store.redo(); toast('Redone'); }
      else if (store.canUndo()) { store.undo(); usage.record('UNDO'); toast('Undone'); }
      return;
    }

    if (typing || modal) return;

    const action = KEY_ACTIONS[e.key];
    if (!action) return;
    if (e.key === 'n') e.preventDefault();
    action();
  });
}

/**
 * What each key does. Keyed by the literal `KeyboardEvent.key`, which is
 * lower case for an unshifted letter — so Caps Lock genuinely does disable
 * these, and the help panel says so.
 */
const KEY_ACTIONS = {
  h: () => navigate({ view: 'home' }),
  m: () => navigate({ view: 'month' }),
  w: () => navigate({ view: 'week' }),
  d: () => navigate({ view: 'day' }),
  t: () => navigate({ view: 'day', anchor: todayKey() }),
  r: () => navigate({ view: 'review' }),
  n: () => openItemEditor(null, defaultsForRoute()),
  '/': () => openSearch(),
  ArrowLeft: () => navigate({ anchor: stepAnchor(-1) }),
  ArrowRight: () => navigate({ anchor: stepAnchor(1) }),
  Escape: () => closeDrawers(),
};

/**
 * Catch the two tables drifting apart, which is exactly how the documented
 * list lost `H`. Costs one pass over ten keys at startup and turns a shortcut
 * the panel promises but nothing implements into a console warning instead of
 * a key that silently does nothing.
 */
function auditShortcuts() {
  const declared = declaredKeys();
  const implemented = Object.keys(KEY_ACTIONS);
  const promised = declared.filter((k) => !implemented.includes(k));
  const undocumented = implemented.filter((k) => !declared.includes(k));
  if (promised.length) console.warn('Shortcuts listed but not implemented: %s', promised.join(', '));
  if (undocumented.length) console.warn('Shortcuts implemented but not listed: %s', undocumented.join(', '));
}

/* ------------------------------------------------------------------ */
/* Swipe (mobile day navigation)                                       */
/* ------------------------------------------------------------------ */

function installSwipe() {
  let startX = 0;
  let startY = 0;
  let tracking = false;

  bodyEl.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    tracking = true;
  }, { passive: true });

  bodyEl.addEventListener('touchend', (e) => {
    if (!tracking) return;
    tracking = false;
    const dx = e.changedTouches[0].clientX - startX;
    const dy = e.changedTouches[0].clientY - startY;
    // Horizontal intent only — otherwise this fights vertical scrolling.
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.8) return;
    if (!['month', 'week', 'day'].includes(route.view)) return;
    navigate({ anchor: stepAnchor(dx < 0 ? 1 : -1) });
  }, { passive: true });
}

/* ------------------------------------------------------------------ */
/* Render                                                              */
/* ------------------------------------------------------------------ */

/**
 * Focus survival across re-renders.
 *
 * Rendering replaces whole regions, so the input you are typing into is
 * destroyed and rebuilt. Anything can trigger that — most often a background
 * sync landing a few seconds after you start typing. The old element loses
 * focus, your next keystrokes hit document.body, and the global single-letter
 * shortcuts read them as commands: typing a word could silently throw you into
 * Month view. Snapshot the caret before a render and put it back after.
 */
function captureFocus() {
  const node = document.activeElement;
  const id = node?.dataset?.focusId;
  if (!id) return null;
  return {
    id,
    value: node.value,
    start: node.selectionStart,
    end: node.selectionEnd,
    // How far the caret had pushed the text up inside its own box. Restoring
    // the caret without this puts the cursor on line 20 of a box scrolled to
    // line 1, which looks exactly like the app eating your typing.
    scrollTop: node.scrollTop,
  };
}

/**
 * Where each scrolling region had got to.
 *
 * Emptying an element collapses its scroll height, which forces scrollTop to
 * zero; refilling it does not bring the position back. So every render sent
 * the day panel, the rail and the main body back to the top — you write a note
 * halfway down the day view, it saves, and the page jumps to the top.
 *
 * Matched by selector rather than by element because most of these are rebuilt
 * from scratch, so the node captured is not the node restored.
 */
const SCROLL_REGIONS = ['#viewBody', '.day-side', '.rail-body', '.sidebar'];

function captureScroll() {
  const out = [];
  for (const sel of SCROLL_REGIONS) {
    const node = document.querySelector(sel);
    if (node?.scrollTop) out.push({ sel, top: node.scrollTop });
  }
  return out;
}

function restoreScroll(marks) {
  for (const { sel, top } of marks) {
    const node = document.querySelector(sel);
    if (node) node.scrollTop = top;
  }
}

function restoreFocus(snapshot) {
  if (!snapshot) return;
  const node = document.querySelector(`[data-focus-id="${CSS.escape(snapshot.id)}"]`);
  if (!node) return;
  // A half-typed value is not in the store yet, so the rebuilt input is empty.
  if (snapshot.value != null && node.value !== snapshot.value) node.value = snapshot.value;
  node.focus({ preventScroll: true });
  try {
    node.setSelectionRange(snapshot.start ?? node.value.length, snapshot.end ?? node.value.length);
  } catch {
    // Not all input types support selection ranges; focus alone is enough.
  }
  // A textarea that grows to fit its content needs to be re-measured against
  // the value we just put back, and this must happen before the scroll
  // position is set — a shorter box would clamp it.
  node.dispatchEvent(new CustomEvent('refit'));
  // Last, because both focus() and setSelectionRange() scroll the caret into
  // view and would otherwise overwrite it.
  if (snapshot.scrollTop) node.scrollTop = snapshot.scrollTop;
}

let renderQueued = false;

/**
 * Coalesce redraws to one per tick.
 *
 * Deliberately NOT requestAnimationFrame: rAF never fires while the tab is
 * hidden, so an app opened in a background tab (or restored by the phone into
 * a backgrounded PWA) would sit blank until it happened to be focused.
 * A timeout runs regardless of visibility.
 */
function render() {
  if (renderQueued) return;
  renderQueued = true;
  setTimeout(() => {
    renderQueued = false;
    const focus = captureFocus();
    const scroll = captureScroll();
    try {
      renderSidebar();
      renderHeader();
      renderBody();
      renderRail();
      renderTabbar();
      // Re-render replaces the drawers' contents, so re-apply the guard.
      syncDrawerState();
    } catch (err) {
      // A view that throws must not leave the app permanently blank.
      console.error('Render failed', err);
      toast('Something went wrong drawing the page.', { error: true });
    }
    restoreFocus(focus);
    restoreScroll(scroll);
  }, 0);
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

function boot() {
  restoreRoute();
  applyTheme();

  // Everything redraws on a change, EXCEPT a diary entry still being typed.
  // Those save every 700ms, and redrawing rebuilt the textarea mid-sentence:
  // the caret survived (restoreFocus) but the box's own scroll position did
  // not, so past the seventh line the view snapped back to the top and you
  // could no longer see the words you were typing. Sync still hears this
  // label, so the entry is pushed to Drive on the usual three-second debounce.
  store.subscribe((_state, detail) => {
    if (detail?.label === 'journal-live') return;
    render();
  });

  // Views that hold their own presentation state — which collapsed hours are
  // open, whether the all-day strip is expanded — ask for a redraw this way.
  // Nothing about the data changed, so routing it through store.mutate would
  // mean a pointless write to disk and a pointless push to Drive.
  /* A save that failed is the one failure the app cannot shrug off: everything
     keeps working and nothing survives a reload. Long duration and no action,
     because there is nothing this can do about it — the point is that the
     person finds out now rather than tomorrow. */
  document.addEventListener('organizer:save-failed', (e) => {
    toast(
      `Could not save to this device (${e.detail?.message || 'storage error'}). `
      + 'Recent changes may not survive a reload.',
      { error: true, duration: 15000 },
    );
  });

  document.addEventListener('organizer:rerender', () => render());
  sync.addEventListener('change', () => {
    // Only the sync chip changes, so avoid a full redraw on every tick.
    const existing = sidebarEl.querySelector('.sync-status');
    if (existing) existing.replaceWith(syncStatusButton());
  });

  runRollover();

  installKeyboard();
  auditShortcuts();
  installSwipe();
  mountClockWidget();
  startClockTicker();
  mountShortcutsButton();
  // Lives on <body>, not in a view: every view rebuilds on render, and the
  // bin has to survive a redraw that lands mid-drag.
  mountBin();

  window.addEventListener('resize', debounceRender());

  // Keep "today" honest if the app is left open across midnight — and run the
  // carry-over then too, rather than waiting for the next reload.
  setInterval(() => {
    runRollover();
    if (route.view === 'day' && route.anchor !== todayKey()) return;
    // Not while you are writing something. This redraw only moves the now-line
    // and re-reads the date, and it was rebuilding the diary box under the
    // caret once a minute for as long as you kept typing. Nothing here is
    // urgent enough to interrupt a sentence; the next tick picks it up.
    if (document.activeElement?.dataset?.focusId) return;
    render();
  }, 60_000);

  render();

  // Silent reconnect, then a first sync — never blocks first paint.
  sync.resume().then((ok) => { if (ok) sync.syncNow({ quiet: true }); });

  offerReview();

  notifications.init();
  registerServiceWorker();
}

/**
 * Mention the review once, when a block has finished.
 *
 * Once per session, not once per load, and never twice in the same session:
 * `reviewDue()` stays true until the review is actually marked done, so an
 * ungated prompt would appear on every single open until then. A reminder you
 * cannot get rid of by any means except obeying it stops being a reminder and
 * becomes something you learn to dismiss without reading.
 */
function offerReview() {
  if (!reviewDue()) return;
  try {
    if (sessionStorage.getItem('daily-organizer:review-offered')) return;
    sessionStorage.setItem('daily-organizer:review-offered', '1');
  } catch { /* private mode: it shows once per load instead */ }

  const block = shiftBlock();
  const what = block ? `${formatDayShort(block.start)}–${formatDayShort(block.end)}` : 'that block';
  toast(`Block finished (${what}). Read it back?`, {
    action: 'Review',
    onAction: () => navigate({ view: 'review' }),
    duration: 9000,
  });
}

/**
 * Carry unfinished work forward, once per day, and say what moved.
 *
 * Announced rather than silent: this shifts dates that sync to a real
 * calendar, so it has to be visible and undoable in one click.
 */
function runRollover() {
  if (!rolloverDue()) return;
  const { moved, unscheduled, total } = rollOverdueTasks();
  if (!total) return;

  const parts = [];
  if (moved.length) parts.push(`${moved.length} moved to today`);
  if (unscheduled.length) parts.push(`${unscheduled.length} sent to Unscheduled`);

  toast(`Carried over: ${parts.join(', ')}`, {
    action: 'Undo',
    onAction: () => { store.undo(); render(); },
    duration: 9000,
  });
}

function debounceRender() {
  let t;
  return () => { clearTimeout(t); t = setTimeout(render, 150); };
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // file:// has no service worker scope; the app must be served over http(s).
  if (location.protocol === 'file:') return;
  try {
    const reg = await navigator.serviceWorker.register('sw.js', {
      // Fetch sw.js from the server, never from the HTTP cache. Pages serves
      // max-age=600 on everything including the worker itself, so without this
      // the browser can answer the update check with the OLD worker — and a
      // worker that never updates never runs its activate handler, never drops
      // the stale cache, and keeps serving last week's app. This is how six
      // deploys reached the server without reaching the phone.
      updateViaCache: 'none',
    });

    // Check again whenever the app is brought back to the foreground. A phone
    // keeps a PWA alive for days, so waiting for a cold start means waiting
    // days for a fix.
    const check = () => { reg.update().catch(() => {}); };
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') check();
    });

    watchForUpdate();
  } catch (err) {
    console.warn('Service worker did not register.', err.message);
  }
}

/**
 * The build this device is running, plus a way to force the check.
 *
 * The worker now updates itself on every foregrounding, so this button should
 * never be necessary. It exists because "should never be necessary" is what
 * was believed about the last six deploys, and having a button beats having to
 * talk someone through clearing a phone's site data.
 */
function versionField() {
  const stamp = el('span.version-stamp', 'checking…');

  // Compare what this device is RUNNING against what the server is offering.
  // A bare version number cannot be acted on — you have nothing to compare it
  // with — and that is exactly how a device sat one deploy behind while its
  // stamp and the server's agreed. This says up to date, or it does not.
  Promise.all([activeBuild(), serverBuild()]).then(([mine, theirs]) => {
    if (!mine) { stamp.textContent = 'no offline cache on this device'; return; }
    if (!theirs) { stamp.textContent = `${mine} (could not reach the server)`; return; }
    const same = mine === theirs;
    stamp.textContent = same
      ? `${mine} · up to date`
      : `${mine} · server has ${theirs} — tap Check for updates`;
    stamp.classList.toggle('is-stale', !same);
  });

  const button = el('button.btn', {
    onclick: async () => {
      button.disabled = true;
      button.textContent = 'Checking…';
      try {
        const reg = await navigator.serviceWorker?.getRegistration();
        if (!reg) { toast('No service worker on this device.', { error: true }); return; }
        await reg.update();
        // If an update was found the worker activates and controllerchange
        // reloads the page, so anything after this may never run.
        setTimeout(() => {
          button.disabled = false;
          button.textContent = 'Check for updates';
          toast('Already on the latest version.');
        }, 1500);
      } catch (err) {
        button.disabled = false;
        button.textContent = 'Check for updates';
        toast(`Could not check: ${err.message}`, { error: true });
      }
    },
  }, 'Check for updates');

  return el('div.field',
    el('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
      button, stamp),
    el('p.field-hint',
      'The app checks for a new version every time you open it. If this build number ',
      'does not match what you expect after a deploy, close the app completely and reopen it.'),
  );
}

/**
 * The build the SERVER is offering, read out of sw.js itself.
 *
 * `no-store` because asking the cache what the server has would defeat the
 * entire purpose of asking.
 */
async function serverBuild() {
  try {
    const res = await fetch('sw.js', { cache: 'no-store' });
    if (!res.ok) return null;
    const match = /CACHE_VERSION\s*=\s*['"]([^'"]+)['"]/.exec(await res.text());
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/** The service worker's own cache name — one source of truth for the build. */
async function activeBuild() {
  try {
    const keys = await caches.keys();
    return keys.find((k) => k.startsWith('organizer-')) || null;
  } catch {
    return null;
  }
}

/**
 * Reload once when a new worker takes over.
 *
 * The worker calls skipWaiting(), so a new version activates as soon as it
 * installs — but the page already running is still executing the old modules.
 * Without this the user sees the new code only on their next manual reload,
 * which on an installed PWA may be never.
 *
 * Guarded because controllerchange also fires the first time a worker claims
 * an uncontrolled page, and reloading there would be a loop on first visit.
 */
function watchForUpdate() {
  if (!navigator.serviceWorker.controller) return;   // first-ever load: nothing to replace
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });
}


boot();

// Exposed for debugging from the console.
window.organizer = { store, route, navigate, sync, google, parseCommand, render };
