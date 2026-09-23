# Mobile editor and navigation audit

Audited September 23, 2026 using Chrome DevTools on Garnet and Playwright against the isolated test application. Scores describe this editor's usability goals; they are not Lighthouse scores.

## Rubric

Rate each category from 0–5 and multiply by its weight divided by five. A 5 means all checks pass, 4 means one verification gap or minor issue, 3 means usable with noticeable friction, 2 means substantial friction, 1 means mostly unusable, and 0 means unavailable.

| Category | Weight | Full-credit checks | After |
| --- | ---: | --- | ---: |
| Writing space | 35 | Header ≤44 px; editor begins ≤146 px below viewport top, excluding safe areas; two compact formatting rows with every command visible; no document outer margins; remaining height is editable | 35 |
| Startup and continuity | 25 | Restore the remembered document on fresh and returning devices; explicit links work; cached documents reopen offline; navigation starts closed; delayed restoration does not override user actions | 25 |
| Touch and navigation | 20 | Header/navigation controls ≥44 × 44 px; formatting controls ≥44 px wide × 32 px tall (the user-selected compact size); every formatting command visible without scrolling; formatting retains selection; navigation supports document selection, search, dismissal and keyboard focus containment; AI opens and closes | 20 |
| Viewport resilience | 20 | Portrait and landscape work; no page overflow; long titles/text remain contained; safe-area spacing is supported; actual mobile keyboard behavior verified | 16 |
| **Total** | **100** | | **96** |

The initial visual audit was approximately **50/100**. The current **96/100 is provisional**: real iOS Safari, browser chrome, notches and the physical software keyboard have not been tested. Chrome touch emulation and a reduced-height viewport do not establish those results. Four points remain reserved for that verification.

Desktop header/document spacing and preservation of document data are mandatory gates independently of the numeric score. Removing the permanent desktop sidebar and centering the editor in the freed space is an intentional user-requested change.

The user subsequently chose 32 px formatting controls and two rows instead of horizontal scrolling. The space and touch criteria above reflect that explicit tradeoff; desktop formatting is unchanged. The title and toolbar now have no surrounding vertical margins. Decorative borders beneath the mobile header and toolbar and above the word count are removed.

## Measurements

Measurements use CSS pixels with the document at the top and the keyboard closed. Device safe-area values are zero in these emulations.

| Viewport | Before: editor top | After: editor top | Before: text width | After: text width |
| --- | ---: | ---: | ---: | ---: |
| 375 × 667 | 251.4 | 140.8 | 329 | 367 |
| 390 × 844 | 251.4 | 140.8 | 344 | 382 |
| 412 × 915 | 251.4 | 140.8 | 366 | 404 |
| 430 × 932 | 251.4 | 140.8 | 384 | 422 |
| 844 × 390, touch landscape | 246.2 | 140.8 | 780 | 836 |

The portrait editor gains about **111 vertical pixels** and **38 horizontal pixels**. The header is 44 px; the two formatting rows are 32 px each, totaling 64 px without divider borders. The text has a 4 px internal inset, with additional clearance only for device safe areas. Extra checks cover 320 × 568, 760 × 900 and 390 × 400. Desktop checks cover widths of 761, 1280 and 1920 px.

## Behavior and regression checks

- The hamburger contains documents, search, pins, document actions, trash and account controls on desktop and mobile. Desktop uses a popover beneath the header; mobile uses a drawer. Neither reserves editor space or persists an open state.
- Existing desktop document padding, title type size and 69 px header are retained. Opening navigation does not shift the document.
- Startup first uses cached data, then rechecks the remembered document after server preferences arrive. Missing/deleted documents are excluded. Explicit hash changes select available documents in the same tab.
- Startup restoration cannot replace a newly selected/created document or dismiss a menu opened while loading.
- Browser regressions cover fresh-device/root/offline restoration, explicit links, startup races, empty state, pins, search, keyboard dismissal and focus, backdrop dismissal, touch formatting, long content, AI, collaboration, history, exports and recovery.

The verification loop exposed and fixed focus escaping the menu, ignored same-tab document links and startup dismissing an already-open menu. Layout screenshots are generated in `test-results/mobile-*.png` and `test-results/navigation-desktop*.png` by the browser suite.
