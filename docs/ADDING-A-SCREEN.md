# Adding a screen (web UI)

The redesign UI has two shells — **mobile** (`web/src/design/MobileApp.tsx`, phone frame +
bottom-tab nav) and **desktop** (`web/src/design/DesktopApp.tsx`). Screens are thin,
presentational views; they pull data from **view-model hooks** in
`web/src/design/wiring.ts`, which wrap the API/BLE so the screens hold no data-fetching or
shaping logic. (The legacy `web/src/screens/` tree was removed in v0.4.0 — ignore it.)

## Recipe (in order)

1. **Data first — a hook in `web/src/design/wiring.ts`.**
   Add `export function useMyThing(): MyThingVM { … }` that calls the relevant API endpoints
   / live hooks and returns *exactly* what the screen renders. This is the seam — keep
   data-shaping here, not in the component. (See existing hooks like `useReadiness`,
   `useTrainingLoadSeries`, `useHR24h`.)

2. **Mobile page — `web/src/design/pages/MyThing.tsx`.**
   `export function MyThing()` consuming `useMyThing()` and the shared cards/charts in
   `design/` (`ui.tsx`, `charts.tsx`).

3. **Desktop page — `web/src/design/desktop/DMyThing.tsx`** *(only if it needs a distinct
   desktop layout)*. Reuse the same hook + shared components; the two pages differ in
   *layout*, not data.

4. **Register it.** Two cases:

   **A tab (top-level nav destination):**
   - `web/src/design/ui.tsx` — add the id to the `TabId` union (~line 101) and an entry to
     the `TABS` array (~line 433): `{ id, label, icon }`.
   - `web/src/design/MobileApp.tsx` — add a `PAGE_META[id] = { title, sub, Comp: MyThing }`
     entry and add `id` to `TAB_ORDER`.
   - `web/src/design/DesktopApp.tsx` — add it to the desktop nav/routing (import the desktop
     page).

   **A sub-page (opened from another screen, not a tab):**
   - Skip the tab wiring. Push it via the shell's `openPage(<MyThing />)` from the screen
     that links to it (the mobile shell threads an `openPage` callback through its pages).

5. **Typecheck:** `npm --prefix web run build` (runs `tsc --noEmit && vite build`).

## Notes

- **Mobile and desktop pages are intentionally separate components** (different layouts).
  Share the *hook* and reusable card/chart components — do **not** try to share the layout.
- **No backend change** is needed for a screen that reads existing endpoints. If it needs
  new data, add the call in `web/src/api/endpoints.ts`, then have the `wiring.ts` hook consume
  it (so the component still only sees a view-model).
- Keep the component dumb: if you find yourself fetching or massaging data inside
  `MyThing.tsx`, push that into `useMyThing()`.
