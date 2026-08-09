/* Application controller: routing, chrome, and wiring.
 *
 * Rendering is deliberately full-redraw-per-region rather than a virtual DOM.
 * The data here is small (a few hundred items at most), the views are cheap,
 * and "rebuild the region on change" removes a whole category of stale-UI
 * bugs for a fraction of the complexity a diffing layer would cost.
 */

import { el, clear, icon, toast, openModal, confirmDialog, isMobile, isTablet, $ } from './ui.js';
import {
  store, settings, updateSettings, addList, removeList, renameList,
  liveItems, itemsOnDay, itemsInRange, unscheduledTasks, overdueTasks,
  tasksInList, progressFor, completionHistory, currentStreak, getList,
  completedItems,
} from './state.js';
import {
  todayKey, addDays, addMonths, weekDays, fromKey,
  formatMonthLong, formatWeekRange, formatDayLong, formatDayShort,
  isoWeekNumber, DAY_ABBR, monthGrid, isToday, sameMonth,
} from './dates.js';
import {
  monthView, weekView, dayView, fitMonthChips, makeDropTarget, dayStrip,
} from './views/calendar.js';
import { doneView } from './views/done.js';
import { mountClockWidget, startClockTicker } from './views/clocks.js';
import { homeView } from './views/home.js';
import { taskList, quickAdd, openItemEditor, confirmDeleteList } from './views/tasks.js';
import { progressRing, historyColumns, listBars, sparkline } from './chart.js';
// Speech capture is currently switched off — see the note at the top of
// voice.js. The natural-language parser stays, because it is what makes the
// quick-add boxes understand "call mum tomorrow at 3".
import { parseCommand } from './voice.js';
import { sync, SyncState } from './sync.js';
import { google } from './google.js';
import { notifications } from './notify.js';

/* ------------------------------------------------------------------ */
/* Route                                                               */
/* ------------------------------------------------------------------ */

const route = {
  view: 'home',         // home | month | week | day | tasks | stats
  anchor: todayKey(),   // the date the view is centred on
  listId: null,         // when view === 'tasks'
};

function navigate(patch) {
  Object.assign(route, patch);
  persistRoute();
  render();
}

function persistRoute() {
  try {
    sessionStorage.setItem('daily-organizer:route', JSON.stringify(route));
  } catch { /* private mode */ }
}

function restoreRoute() {
  try {
    const saved = JSON.parse(sessionStorage.getItem('daily-organizer:route'));
    if (saved?.view) Object.assign(route, saved);
    // Never restore to a stale day — reopening the app means "now".
    if (route.view === 'day' && route.anchor < todayKey()) route.anchor = todayKey();
  } catch { /* fine */ }
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
    navItem('chart', 'Progress', null, route.view === 'stats',
      () => navigate({ view: 'stats' })),
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
    count != null && count > 0
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

  return el('button.sync-status', {
    title: sync.lastError?.message || sync.message,
    onclick: () => {
      if (sync.state === SyncState.ERROR || sync.state === SyncState.IDLE) openSettings('google');
      else sync.syncNow();
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
  crumbs.appendChild(el('button.crumb', {
    class: route.view === 'month' ? 'is-current' : '',
    onclick: () => navigate({ view: 'month' }),
  }, formatMonthLong(route.anchor)));

  if (route.view === 'week' || route.view === 'day') {
    crumbs.appendChild(el('span.crumb-sep', '›'));
    crumbs.appendChild(el('button.crumb', {
      class: route.view === 'week' ? 'is-current' : '',
      onclick: () => navigate({ view: 'week' }),
    }, `Week ${isoWeekNumber(route.anchor)} · ${formatWeekRange(route.anchor, cfg.weekStart)}`));
  }

  if (route.view === 'day') {
    crumbs.appendChild(el('span.crumb-sep', '›'));
    crumbs.appendChild(el('span.crumb.is-current',
      route.anchor === todayKey() ? 'Today' : formatDayLong(route.anchor)));
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
  }));

  root.appendChild(taskList(items, {
    emptyMessage,
    emptyHint: route.listId === 'overdue' ? '' : 'Type above, or use the microphone.',
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

  // The rail follows the calendar; in list views the main area already is
  // the list, so showing it twice would be noise.
  const dayKey = route.view === 'day' ? route.anchor : todayKey();
  const items = itemsOnDay(dayKey);
  const unscheduled = unscheduledTasks().filter((i) => !i.done).slice(0, 12);
  const prog = progressFor(items);

  railEl.appendChild(el('div.rail-header',
    el('div.rail-title',
      el('span', dayKey === todayKey() ? 'Today' : formatDayShort(dayKey)),
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
/* Settings                                                            */
/* ------------------------------------------------------------------ */

function openSettings(focusSection = null) {
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
        return calendars.length;
      };

      fields.push(el('div.field',
        el('label', 'Calendar'),
        calSelect,
        el('p.field-hint', 'Connect to load your calendars.'),
      ));

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
      else if (store.canUndo()) { store.undo(); toast('Undone'); }
      return;
    }

    if (typing || modal) return;

    switch (e.key) {
      case 'h': navigate({ view: 'home' }); break;
      case 'm': navigate({ view: 'month' }); break;
      case 'w': navigate({ view: 'week' }); break;
      case 'd': navigate({ view: 'day' }); break;
      case 't': navigate({ view: 'day', anchor: todayKey() }); break;
      case 'n': e.preventDefault(); openItemEditor(null, defaultsForRoute()); break;
      case 'ArrowLeft': navigate({ anchor: stepAnchor(-1) }); break;
      case 'ArrowRight': navigate({ anchor: stepAnchor(1) }); break;
      case 'Escape': closeDrawers(); break;
      default: break;
    }
  });
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
  };
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
  }, 0);
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

function boot() {
  restoreRoute();
  applyTheme();

  store.subscribe(() => render());
  sync.addEventListener('change', () => {
    // Only the sync chip changes, so avoid a full redraw on every tick.
    const existing = sidebarEl.querySelector('.sync-status');
    if (existing) existing.replaceWith(syncStatusButton());
  });

  installKeyboard();
  installSwipe();
  mountClockWidget();
  startClockTicker();

  window.addEventListener('resize', debounceRender());

  // Keep "today" honest if the app is left open across midnight.
  setInterval(() => {
    if (route.view === 'day' && route.anchor !== todayKey()) return;
    render();
  }, 60_000);

  render();

  // Silent reconnect, then a first sync — never blocks first paint.
  sync.resume().then((ok) => { if (ok) sync.syncNow({ quiet: true }); });

  notifications.init();
  registerServiceWorker();
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
    await navigator.serviceWorker.register('sw.js');
  } catch (err) {
    console.warn('Service worker did not register.', err.message);
  }
}

boot();

// Exposed for debugging from the console.
window.organizer = { store, route, navigate, sync, google, parseCommand, render };
